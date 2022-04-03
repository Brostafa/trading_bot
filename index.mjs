import { config } from 'dotenv'
config()

import { binanceEmitter, Binance, PAIRS } from './Binance.mjs'
import { subDays, startOfDay, addDays } from 'date-fns'
import Strategy from './Strategy.mjs'
import logger from './logger.mjs'
import { Events, Orders, Trades } from './models/index.mjs'

const binance = new Binance({
	apiKey: process.env.BINANCE_API_KEY,
	apiSecret: process.env.BINANCE_SECRET_KEY
})

let ACTIVE_ORDER = {}

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

const handleStopLoss = (strategy, activeOrder, stopLoss) => {
	logger.info(`[Order Exit] Stop loss setup symbol="${strategy.pair}" stopLoss="${stopLoss}"`)
	
	const sellOrder = async ({ price }) => {
		if (price <= stopLoss) {
			logger.info(`[Order Exit] Stop loss triggered symbol="${strategy.pair}" symbolPrice="${price}" stopLoss="${stopLoss}"`)
			
			const order = await binance.sellMarketOrder(strategy.pair, price, activeOrder.executedAmount)

			strategy.setOrderStatus(order.side, order.status)
			binanceEmitter.off(symbol, sellOrder)
		}
	}
	
	binanceEmitter.on(symbol, sellOrder)
}

const handleTakeProfit = async (strategy, activeOrder, takeProft) => {
	const { executedAmount, symbol } = activeOrder

	logger.info(`[Order Exit] Take profit setup sellCoins="${executedAmount}" symbol="${symbol}" takeProfit="${takeProfit}"`)

	const order = await binance.sellMarketOrder({
		symbol,
		amount: executedAmount,
		clientOrderId: order.clientOrderId,
		limitPrice: takeProft
	})

	ACTIVE_ORDER = order
	
	logger.info(`[Order Exit] Take profit sellCoins="${executedAmount}" orderId="${order.orderId}" status="${order.status}"`)

	strategy.setOrderStatus(order.side, order.status)
	watchOrderTillFill(strategy, order.orderId, payload)

	return order
}

const watchOrderTillFill = async (strategy, orderId, payload) => {
	try {
		const order = await binance.getOrder({
			symbol: strategy.pair,
			orderId
		})	
	
		if (order.status === 'filled' || order.status === 'cancelled') {
			logger.info(`[Watch Order] status="${order.status}" orderId="${orderId}" pair="${strategy.pair}" price="${order.price}"`)

			strategy.setOrderStatus(order.side, order.status)
			ACTIVE_ORDER = order
		} else {
			setTimeout(() => watchOrderTillFill(strategy, orderId), 1000)
		}

		// if we fulfilled buy order then sell it for takeprofit/stoploss
		if (order.side === 'buy' && order.status === 'filled') {
			const { takeProfit, stopLoss } = payload
			const tpOrder = await handleTakeProfit(strategy, ACTIVE_ORDER, takeProfit)

			await handleStopLoss(strategy, tpOrder, stopLoss)
		}
	} catch (e) {
		logger.error(`[Watch Order] error="${e.message || e.body || e}" orderId="${orderId}" pair="${strategy.pair}"`)

		setTimeout(() => watchOrderTillFill(strategy, orderId), 1000)
	}
}

const start = async () => {
	try {
		const strategy = await getStrategy()

		if (!strategy) {
			logger.warn('[Bot] No strategy found')			
		}
			
		logger.info(`[Bot] Strategy found for ${strategy.pair}`)

		while (strategy.canRun()) {
			const { action, payload } = await strategy.run()
			
			if (action === 'wait_for_cross_over') {
				const { openDate, close } = payload.currentCandle
				
				logger.info(`[Bot] action="${action}" close="${close}" openDate="${openDate.toJSON()}"`)
			} else {
				logger.info(`[Bot] action="${action}" payload="${payload ? JSON.stringify(payload) : ''}"`)
			}

			if (action === 'buy') {
				const { currentCandle, entryPrice, takeProft, stopLoss, possibleProfit } = payload

				logger.info(`[Bot] currentCandle="${currentCandle.openDate.toJSON()}" entryPrice="${entryPrice}" takeProft="${takeProft}" stopLoss="${stopLoss}" possibleProfit="${binance.round(possibleProfit)}%"`)
				
				const balance = await binance.getBalance('BUSD') - 1
				const order = await binance.buyStopLimitOrder({
					symbol: strategy.pair,
					balance,
					limitPrice: entryPrice
				})

				ACTIVE_ORDER = order

				strategy.setOrderStatus(order.side, order.status)

				if (order.status === 'placed') {
					watchOrderTillFill(strategy, order.orderId, payload)
				}
			} else if (action === '	cancel_buy') {
				// cancel buy order
				if (ACTIVE_ORDER.side === 'buy' && ACTIVE_ORDER.status === 'placed') {
					const order = await binance.cancelOrder(ACTIVE_ORDER.orderId, strategy.pair)

					ACTIVE_ORDER = order
					strategy.setOrderStatus(order.side, order.status)
				}
			} else if (action === 'sell') {
				binance.sellMarketOrder({
					symbol: strategy.pair,
					amount: ACTIVE_ORDER.executedAmount,
					clientOrderId: ACTIVE_ORDER.clientOrderId
				})
			}

			await strategy.waitNextCandle()
		}

		logger.info(`[Bot] strategy done reason="${strategy.reason}"`)

		setTimeout(start, 1000)
	} catch (e) {
		logger.error(e)
	}
} 

// start()