import { config } from 'dotenv'
config()

import { PAIRS } from './exchanges/Binance.mjs'
import { subDays, startOfDay, addDays } from 'date-fns'
import Strategy from './strategies/RsiOverSma.mjs'
import logger from './logger.mjs'
import { Events, Campaigns } from './models/index.mjs'
import { handleSell, handleBuy, handleCancel } from './trader.mjs'

const ACTIVE_CAMPAIGNS = []

const getStrategy = async () => {
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

const prepStrategy = (strategy, campaign) => {
	const { activeOrder } = campaign
	
	if (activeOrder) {
		const { side, status } = activeOrder

		strategy.setOrderStatus(side, status)
		// @TODO: implement take profit / stoploss watcher
	}
}

const handleCampaign = async campaign => {
	try {
		const strategy = await getStrategy(campaign.strategy)

		prepStrategy(strategy, campaign)

		const { _id: campaignId } = campaign

		if (!strategy) {
			throw new Error('[Bot] No strategy found')
		}
			
		logger.info(`[Bot] Strategy found for pair="${strategy.pair}"`)

		while (strategy.canRun()) {
			const { action, payload } = await strategy.run()
			const actionsToSave = ['buy', 'cancel_buy', 'sell']
			let clientOrderId = null
			
			if (action === 'wait_for_cross_over') {
				const { openDate, close } = payload.currentCandle
				
				logger.info(`[Bot] action="${action}" close="${close}" openDate="${openDate.toJSON()}"`)
			} else {
				logger.info(`[Bot] action="${action}" payload="${payload ? JSON.stringify(payload) : ''}"`)
			}

			if (action === 'buy') {
				const order = await handleBuy({ payload, strategy, campaignId })

				clientOrderId = order?.clientOrderId
			} else if (action === '	cancel_buy') {
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
	} catch (e) {
		logger.error(e)
	}

	setTimeout(() => handleCampaign(campaign), 1000)
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
			handleCampaign(campaign)

			ACTIVE_CAMPAIGNS.push(campaign._id)
		}
	} catch (e) {
		logger.error(`[Watch Campaigns] ${e}`)
	}

	setTimeout(watchCampaigns, 1000)
}

watchCampaigns()
