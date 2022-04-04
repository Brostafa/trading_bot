
import { binanceEmitter, Binance, round, getBaseTicker } from './exchanges/Binance.mjs'
import logger from './logger.mjs'
import { Orders, Trades, Campaigns } from './models/index.mjs'

const binance = new Binance({
	apiKey: process.env.BINANCE_API_KEY,
	apiSecret: process.env.BINANCE_SECRET_KEY
})

const handleStopLoss = ({ strategy, stopLoss, campaignId }) => {
	const symbol = strategy.pair

	logger.info(`[Stop Loss] setup symbol="${symbol}" stopLoss="${stopLoss}"`)
	
	const sellOrder = async ({ price }) => {
		if (price <= stopLoss) {
			logger.info(`[Stop Loss] triggered symbol="${symbol}" symbolPrice="${price}" stopLoss="${stopLoss}"`)
			
			await handleSell({
				strategy,
				campaignId
			})

			binanceEmitter.off(symbol, sellOrder)
		}
	}
	
	binanceEmitter.on(symbol, sellOrder)
}

const handleTakeProfit = async ({ strategy, order: oldOrder, takeProfit, campaignId }) => {
	const { activeOrder } = await Campaigns.findById(campaignId)
	const { executedAmount, symbol, clientOrderId } = oldOrder
	const { status, side } = activeOrder || {}
	const baseTicker = getBaseTicker(symbol)

	if (status === 'placed' && side === 'sell') {
		logger.warn(`[Take Profit] order was already placed -- watching order instead`)
		const { orderId } = activeOrder

		watchOrderTillFill({
			strategy,
			orderId,
			campaignId
		})
	} else {
		logger.info(`[Take Profit] setup sellCoins="${executedAmount} ${baseTicker}" takeProfit="${takeProfit}"`)
	
		const order = await binance.sellLimitOrder({
			symbol,
			amount: executedAmount,
			clientOrderId: clientOrderId,
			limitPrice: takeProfit
		})
		
		logger.info(`[Take Profit] sellCoins="${executedAmount} ${baseTicker}" orderId="${order.orderId}" status="${order.status}"`)
	
		await handleOrderUpdate({ strategy, campaignId, order })
		
		if (order.status === 'placed') {
			watchOrderTillFill({ strategy, orderId: order.orderId, campaignId })
		}

		return order
	}
}

const watchOrderTillFill = async ({ strategy, orderId, campaignId, payload = {} }, retry = 1) => {
	const maxRetries = 5
	const args = { strategy, orderId, campaignId, payload }
	const rerun = () => watchOrderTillFill(args)
	
	try {
		const order = await binance.getOrder({
			symbol: strategy.pair,
			orderId
		})	
	
		if (order.status === 'filled' || order.status === 'cancelled') {
			await handleOrderUpdate({
				strategy,
				campaignId,
				order
			})
		} else {
			setTimeout(rerun, 1000)
		}

		// if we fulfilled buy order then sell it for takeprofit/stoploss
		if (order.side === 'buy' && order.status === 'filled') {
			const { takeProfit, stopLoss } = payload
			
			await handleTakeProfit({ strategy, order, takeProfit, campaignId })
			await handleStopLoss({ strategy, stopLoss, campaignId })
		}
	} catch (e) {
		logger.error(`[Watch Order] orderId="${orderId}" pair="${strategy.pair}" error="${e.message || e.body || e}" stack="${e.stack}" retry="${retry}"`)

		if (retry < maxRetries) {
			setTimeout(() => watchOrderTillFill(args, retry + 1), 1000)
		}
	}
}

const createTrade = async ({ campaignId, order }) => {
	try {
		const { clientOrderId } = order
		const sellOrder = await Orders.findOne({ clientOrderId, side: 'sell', status: 'filled' })
		const buyOrder = await Orders.findOne({ clientOrderId, side: 'buy', status: 'filled' })
		const profitLoss = round(sellOrder.total - buyOrder.total)
		const fees = round(sellOrder.fee + buyOrder.fee)
		const pastTrades = await Trades.find({ campaignId }, { profitLoss: 1 })
		let expectancy, expectancyValue, winRate

		// calculate expectancy
		if (pastTrades.length) {
			const pastWinningTrades = pastTrades.filter(trade => trade.profitLoss >= 0)
			const pastLosingTrades = pastTrades.filter(trade => trade.profitLoss < 0)
			winRate = pastWinningTrades.length / pastTrades.length

			const avgWin = pastWinningTrades.reduce((acc, trade) => acc + trade.profitLoss, 0) / pastWinningTrades.length
			const avgLoss = pastLosingTrades.reduce((acc, trade) => acc + trade.profitLoss, 0) / pastLosingTrades.length
			expectancyValue = (winRate * avgWin) - ((1 - winRate) * avgLoss)
			expectancyValue = round(expectancyValue)
			expectancy = {
				value: expectancyValue,
				profitLosses: pastTrades.map(trade => trade.profitLoss),
			}
		}

		logger.success(`[Trade] profitLoss="${profitLoss}" expectancy="${expectancyValue}" winRate="${round(winRate * 100)}%"`)

		await Trades.create({
			campaignId,
			clientOrderId,
			sellOrderId: sellOrder._id,
			buyOrderId: buyOrder._id,
			profitLoss,
			fees,
			expectancy,
			winRate: round(winRate * 100) || 0
		})
	} catch (e) {
		logger.error(`[Create Trade] error="${e.message || e.body || e}" stack="${e.stack}"`)
	}
}

const handleCampaignFilledOrder = async ({ campaignId, order }) => {
	let campaignUpdate = {}
	const { initialBalance, balance } = await Campaigns.findById(campaignId)

	try {
		const { total, executedAmount } = order
		
		if (order.side === 'buy') {
			const newBalance = balance - total

			campaignUpdate = {
				balance: newBalance,
				coinSymbol: order.symbol,
				coinAmount: executedAmount,
			}
		} else {
			const newBalance = balance + total
			const profitLoss = round(newBalance - initialBalance)
			const profitLossPerc = round(((newBalance / initialBalance) - 1) * 100)

			campaignUpdate = {
				balance: newBalance,
				coinSymbol: null,
				coinAmount: 0,
				profitLoss,
				profitLossPerc: profitLossPerc,
				tradePlan: null,
				activeOrder: null
			}

			logger.info(`[Campaign Balance] Initial Balance="${initialBalance}" Balance="${newBalance}" Profit Loss="$${profitLoss} (${profitLossPerc} %)"`)
		}
		
		await Campaigns.updateOne({
			_id: campaignId
		}, campaignUpdate)
	} catch (e) {
		logger.error(`[Campaign Balance] order="${order}" error="${e.message || e.body || e}" stack="${e.stack}"`)
	}	
}

const handleOrderUpdate = async ({ strategy, campaignId, order }) => {
	strategy.setOrderStatus(order.side, order.status)
	const baseTicker = getBaseTicker(order.symbol)

	logger.info(`[Order Update] status="${order.status}" side="${order.side}" amount="${order.orderAmount} ${baseTicker}" price="${order.executedPrice || order.orderPrice}" reason="${order.reason || ''}" orderId="${order.orderId}"`)

	if (order.status !== 'cancelled') {
		await Campaigns.updateOne({
			_id: campaignId
		}, {
			activeOrder: order
		})
	} else if (order.status === 'cancelled' && order.side === 'buy') {
		await Campaigns.updateOne({
			_id: campaignId
		}, {
			activeOrder: null,
			tradePlan: null
		})
	}


	await Orders.create({
		campaignId,
		...order
	})

	if (order.status === 'filled') {
		handleCampaignFilledOrder({ order, campaignId })
		
		if (order.side === 'sell') {
			createTrade({ order, campaignId })
		}
	}
}

export const handleBuy = async ({ payload, strategy, campaignId }) => {
	const { currentCandle, entryPrice, takeProfit, stopLoss, possibleProfit } = payload
	const campaign = await Campaigns.findById(campaignId)
	const { balance, baseCurrency, activeOrder } = campaign

	logger.info(`[Buy] currentCandle="${currentCandle.openDate.toJSON()}" entryPrice="${entryPrice}" takeProfit="${takeProfit}" stopLoss="${stopLoss}" possibleProfit="${round(possibleProfit)}%" balance="${balance} ${baseCurrency}"`)

	if (activeOrder?.status === 'placed') {
		logger.warn(`[Buy] Failed to place an order as one is already placed - watching order instead`)

		watchOrderTillFill({
			strategy,
			orderId: activeOrder.orderId,
			payload,
			campaignId
		})

		return activeOrder
	}
	
	const order = await binance.buyStopLimitOrder({
		symbol: strategy.pair,
		balance,
		limitPrice: entryPrice
	})
	
	if (order.status === 'placed') {
		watchOrderTillFill({
			strategy,
			orderId: order.orderId,
			payload,
			campaignId
		})
	}
	
	await Campaigns.updateOne({
		_id: campaignId
	}, {
		tradePlan: payload
	})

	await handleOrderUpdate({ strategy, campaignId, order })
	
	return order
}

export const handleSell = async ({ strategy, campaignId }, retry = 1) => {
	const maxRetries = 5

	try {
		const { activeOrder } = await Campaigns.findOne({ _id: campaignId })
		
		if (!activeOrder) {
			logger.warn(`[Sell] No active order found campaignId="${campaignId}"`)

			return
		}
		
		const {
			orderId,
			symbol,
			side,
			executedAmount,
			orderAmount,
			clientOrderId,
			status
		} = activeOrder

		const baseTicker = getBaseTicker(symbol)

		logger.info(`[Sell] activeOrder="${orderId}" amount="${orderAmount} ${baseTicker}" `)
		
		// Cancel takeProfit order if it exists
		if (side === 'sell' && status === 'placed') {
			logger.info(`[Sell] cancelling take profit order orderId="${orderId}"`)

			await handleCancel({
				strategy,
				campaignId
			})
		}
	
		const order = await binance.sellMarketOrder({
			symbol,
			clientOrderId,
			amount: executedAmount || orderAmount,
		})
	
		await handleOrderUpdate({ strategy, campaignId, order })
		
		return order
	} catch (e) {
		logger.error(`[Sell] ${e.body || e.message || e}`)

		if (retry < maxRetries) {
			setTimeout(() => handleSell({ strategy, campaignId }, retry + 1), 1000)
		} else {
			throw e
		}
	}
}

export const handleCancel = async ({ strategy, campaignId }) => {
	const { activeOrder } = await Campaigns.findById(campaignId)

	if (!activeOrder) {
		logger.warn(`[Cancel Order] No active order found campaignId="${campaignId}"`)

		return
	}
	
	const { status, orderId, clientOrderId, symbol } = activeOrder

	if (status === 'placed') {
		logger.info(`[Cancel Order] orderId="${orderId}" symbol="${symbol}"`)
		const order = await binance.cancelOrder({
			symbol,
			orderId,
			clientOrderId
		})

		await handleOrderUpdate({ strategy, campaignId, order })
	
		return order
	} else {
		logger.warn(`[Cancel Order] couldn't cancel an active order - activeOrder="${activeOrder}"`)

		return activeOrder
	}
}