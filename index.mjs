import { config } from 'dotenv'
config()

import { PAIRS } from './exchanges/Binance.mjs'
import { subDays, startOfDay, addDays } from 'date-fns'
import Strategy from './strategies/RsiOverSma.mjs'
import logger from './logger.mjs'
import { Events, Campaigns } from './models/index.mjs'
import { handleSell, handleBuy, handleCancel, watchOrderTillFill, handleStopLoss } from './trader.mjs'

const ACTIVE_CAMPAIGNS = []

const getStrategy = async strategyName => {
	const today = startOfDay(new Date())
	const todayPlusOne = addDays(today, 1)
	const yesterday = subDays(today, 1)

	for (let { pair, tickSize } of PAIRS) {
		const strategy = new Strategy({
			pair,
			tickSize,
			startTime: yesterday.getTime(),
			endTime: todayPlusOne.getTime(),
		})

		await strategy.init()
	
		if (strategy.canRun()) {
			return strategy
		}
	}
}

/**
 * This function will be called when the bot is started
 * to handle if bot stopped mid-trade
 * 
 * @param {Object} strategy strategy
 * @param {Object} campaign campaign
 */
const prepStrategy = (strategy, campaign) => {
	const { activeOrder, tradePlan } = campaign
	
	if (activeOrder) {
		const { side, status } = activeOrder
		const filledBuy = (status === 'filled' && side === 'buy')

		strategy.setOrderStatus(side, status)
		
		// take profit / stoploss watcher
		if (status === 'placed' || filledBuy) {
			if (filledBuy) {
				logger.info(`[Prep Campaign] Creating take profit/stop loss orders for orderId="${activeOrder.orderId}"`)
			} else {
				logger.info(`[Prep Campaign] Initializing watcher for placed ${side} order ${side === 'sell' ? '(take profit)' : ''}`)
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
				logger.info('[Prep Campaign] Initializing watcher for sell order (stop loss)')
	
				handleStopLoss({
					strategy,
					campaignId: campaign._id,
					stopLoss: tradePlan?.stopLoss
				})
			} else {
				logger.warn(`[Prep Campaign] No stop loss set for campaignId="${campaign._id}"`)
			}
		}
	}

	if (tradePlan) {
		strategy.tradePlan = tradePlan
	}
}

const handleCampaignEnd = async campaignId => {
	const {
		initialBalance,
		balance,
		coinAmount,
		coinSymbol,
		profitLoss,
		profitLossPerc
	} = await Campaigns.findById(campaignId)

	logger.success(`[Campaign] ended initBalance="${initialBalance}" balance="$${balance}" profitLoss="$${profitLoss} (${profitLossPerc}%)" coinAmount="${coinAmount} ${coinSymbol}"`)
}


const handleCampaign = async campaignId => {
	try {
		const campaign = await Campaigns.findById(campaignId)
		const {
			name,
			balance,
			profitLoss,
			profitLossPerc,
			strategyName
		} = campaign
		logger.info(`[Campaign] starting name="${name}" balance="${balance}" profitLoss="$${profitLoss} (${profitLossPerc}%)" strategyName="${strategyName}"`)

		const strategy = await getStrategy(campaign.strategyName)

		prepStrategy(strategy, campaign)

		if (!strategy) {
			throw new Error('[Bot] No strategy found')
		}
			
		logger.info(`[Bot] Strategy found for pair="${strategy.pair}"`)

		while (strategy.canRun()) {
			const { action, payload } = await strategy.run()
			const actionsToSave = ['buy', 'cancel_buy', 'sell']
			let clientOrderId = null
			
			if (action === 'wait_for_cross_over') {
				const { closeDate, close } = payload.currentCandle
				
				logger.info(`[Bot] action="${action}" close="${close}" closeDate="${closeDate.toJSON()}"`)
			} else {
				logger.info(`[Bot] action="${action}" payload="${payload ? JSON.stringify(payload) : ''}"`)
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
	
		logger.info(`[Bot] strategy done reason="${strategy.reason}"`)

		await handleCampaignEnd(campaignId)
	} catch (e) {
		logger.error(e)
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

watchCampaigns()
