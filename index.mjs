import { config } from 'dotenv'
config()

import { subDays, startOfDay, addDays, differenceInMilliseconds, formatDistanceStrict } from 'date-fns'
import Strategy from './strategies/RsiOverSma.mjs'
import logger from './logger.mjs'
import { Events, Campaigns } from './models/index.mjs'
import { handleSell, handleBuy, handleCancel, watchOrderTillFill, handleStopLoss } from './trader.mjs'

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

const ACTIVE_CAMPAIGNS = []

class StrategyError extends Error {
	constructor (message, { reason, type }) {
		super(message)

		this.reason = reason
		this.type = type
	}
}

const getStrategy = async (campStrat, quoteCurrency) => {
	const { name, baseSymbols } = campStrat
	const today = startOfDay(new Date())
	const todayPlusOne = addDays(today, 1)
	const yesterday = subDays(today, 1)
	let strategy = {}

	for (let symbol of baseSymbols) {
		strategy = new Strategy({
			// symbol = BTC, quoteCurreny = BUSD
			pair: symbol + quoteCurrency,
			startTime: yesterday.getTime(),
			endTime: todayPlusOne.getTime(),
		})

		await strategy.init()
	
		if (strategy.canRun()) {
			return strategy
		}
	}

	throw new StrategyError('[Bot] No strategy found', {
		type: 'no_strategy_found',
		reason: strategy.reason
	})
}

/**
 * This function will be called when the bot is started
 * to handle if bot stopped mid-trade
 * 
 * @param {Object} strategy strategy
 * @param {Object} campaign campaign
 */
const prepStrategy = (strategy, campaign) => {
	const { activeOrder, tradePlan, name } = campaign
	
	if (tradePlan) {
		strategy.tradePlan = tradePlan
	}

	if (activeOrder) {
		if (strategy.pair !== activeOrder.symbol) {
			logger.error(`[Prep Campaign] camp.name="${name}" Strategy symbol does not match campaign symbol activeOrder.symbol="${activeOrder.symbol}" strategy.pair="${strategy.pair}"`)
	
			throw new Error('[Prep Campaign] Strategy symbol does not match campaign symbol')
		}
		
		const { side, status } = activeOrder
		const filledBuy = (status === 'filled' && side === 'buy')

		strategy.setOrderStatus(side, status)
		
		// take profit / stoploss watcher
		if (status === 'placed' || filledBuy) {
			if (filledBuy) {
				logger.info(`[Prep Campaign] camp.name="${name}" Will create take profit/stop loss orders for orderId="${activeOrder.orderId}" once it gets filled`)
			} else {
				logger.info(`[Prep Campaign] camp.name="${name}" Initializing watcher for placed ${side} order ${side === 'sell' ? '(take profit)' : ''}`)
			}

			watchOrderTillFill({
				strategy,
				orderId: activeOrder.orderId,
				campaignId: campaign._id,
				payload: tradePlan
			})
		}

		if (status === 'placed' && side === 'sell') {
			if (tradePlan?.stopLoss) {
				logger.info(`[Prep Campaign] camp.name="${name}" Initializing watcher for sell order (stop loss)`)
	
				handleStopLoss({
					strategy,
					campaignId: campaign._id,
					stopLoss: tradePlan?.stopLoss
				})
			} else {
				logger.warn(`[Prep Campaign] No stop loss set for campaignId="${campaign._id}" camp.name="${name}" `)
			}
		}
	}
}

const handleCampaignEnd = async campaignId => {
	const {
		name,
		initialBalance,
		balance,
		coinAmount,
		coinSymbol,
		profitLoss,
		profitLossPerc
	} = await Campaigns.findById(campaignId)

	logger.success(`[Campaign] ended camp.name="${name}" initBalance="${initialBalance}" balance="$${balance}" profitLoss="$${profitLoss} (${profitLossPerc}%)" coinAmount="${coinAmount}${coinSymbol ? ' ' + coinSymbol : ''}"`)
}


const handleCampaign = async campaignId => {
	const campaign = await Campaigns.findById(campaignId)
	const {
		name,
		balance,
		profitLoss,
		profitLossPerc,
		strategy: campStrat,
		quoteCurrency
	} = campaign

	try {
		logger.info(`[Campaign] starting name="${name}" balance="${balance}" profitLoss="$${profitLoss || 0} (${profitLossPerc || 0}%)" strategyName="${campStrat.name}"`)

		const strategy = await getStrategy(campStrat, quoteCurrency)

		prepStrategy(strategy, campaign)
			
		logger.info(`[Bot] Strategy found for pair="${strategy.pair}"`)

		while (strategy.canRun()) {
			const { action, payload } = await strategy.run()
			const actionsToSave = ['buy', 'cancel_buy', 'sell']
			let clientOrderId = null
			
			if (action === 'wait_buy_signal') {
				const { closeDate, close } = payload.currentCandle
				
				logger.info(`[Bot] action="${action}" camp.name="${name}" pair="${strategy.pair}" close="${close}" closeDate="${closeDate.toJSON()}"`)
			} else {
				logger.info(`[Bot] action="${action}" camp.name="${name}" pair="${strategy.pair}" payload="${payload ? JSON.stringify(payload) : ''}"`)
			}

			if (action === 'buy') {
				const order = await handleBuy({ payload, strategy, campaignId })

				clientOrderId = order?.clientOrderId
			} else if (action === 'cancel_buy') {
				const order = await handleCancel({ strategy, campaignId })
				
				clientOrderId = order?.clientOrderId
			} else if (action === 'sell') {
				const order = await handleSell({ strategy, campaignId })

				clientOrderId = order?.clientOrderId
			}

			if (actionsToSave.includes(action)) {
				payload.clientOrderId = clientOrderId

				await Events.create({
					campaignId: campaign._id,
					action,
					payload
				})
			}

			await strategy.waitNextCandle()
		}
	
		logger.info(`[Bot] camp.name="${name}" strategy done reason="${strategy.reason}"`)

		await handleCampaignEnd(campaignId)
	} catch (e) {
		
		if (e.type === 'no_strategy_found') {			
			const tomorrow = addDays(startOfDay(new Date()), 1)
			const msTillTomorrow = differenceInMilliseconds(tomorrow, new Date())
			const humanizedMs = formatDistanceStrict(new Date(), Date.now() + msTillTomorrow, { includeSeconds: true })
			
			logger.warn(`[Bot] No strategy found for campaignId="${campaignId}" camp.name="${name}" reason="${e.reason}" will try again in ${humanizedMs}`)
			
			await delay(msTillTomorrow)
		} else {
			logger.error(e)
		}
	}

	setTimeout(() => handleCampaign(campaignId), 1000)
}


const watchCampaigns = async () => {
	try {
		const campaigns = await Campaigns.find({
			status: 'active',
			_id: {
				$nin: ACTIVE_CAMPAIGNS
			}
		})
	
		for (let campaign of campaigns) {
			handleCampaign(campaign._id)

			ACTIVE_CAMPAIGNS.push(campaign._id)
		}
	} catch (e) {
		logger.error(`[Watch Campaigns] ${e}`)
	}

	setTimeout(watchCampaigns, 1000)
}

setTimeout(watchCampaigns, 5000)
