
import { binanceEmitter, Binance, round, getBaseTicker } from './exchanges/Binance.mjs'
import logger from './logger.mjs'
import { Orders, Trades, Campaigns } from './models/index.mjs'

const MAX_BINANCE_WEIGHT = 1200

const binance = new Binance({
	apiKey: process.env.BINANCE_API_KEY,
	apiSecret: process.env.BINANCE_SECRET_KEY
})

export const handleStopLoss = ({ strategy, stopLoss, campaignId }) => {
	const symbol = strategy.pair

	logger.info(`[Stop Loss] setup campId="${campaignId}" symbol="${symbol}" stopLoss="${stopLoss}"`)
	
	const sellOrder = async ({ price }) => {
		if (price <= stopLoss) {
			binanceEmitter.off(symbol, sellOrder)

			logger.info(`[Stop Loss] triggered campId="${campaignId}" symbol="${symbol}" symbolPrice="${price}" stopLoss="${stopLoss}"`)
			
			await handleSell({
				strategy,
				campaignId
			})

			logger.info(`[Stop Loss] SOLD campId="${campaignId}" symbol="${symbol}" symbolPrice="${price}" stopLoss="${stopLoss}"`)
		}
	}
	
	binanceEmitter.on(symbol, sellOrder)
}

const handleTakeProfit = async ({ strategy, order: oldOrder, takeProfit, campaignId }) => {
	const { activeOrder, name } = await Campaigns.findById(campaignId)
	const { executedAmount, symbol, clientOrderId } = oldOrder
	const { status, side } = activeOrder || {}
	const baseTicker = getBaseTicker(symbol)

	if (status === 'placed' && side === 'sell') {
		logger.warn(`[Take Profit] order was already placed -- watching order instead camp.name="${name}" `)
		const { orderId } = activeOrder

		watchOrderTillFill({
			strategy,
			orderId,
			campaignId
		})
	} else {
		logger.info(`[Take Profit] setup takeProfit="${takeProfit}" camp.name="${name}" sellCoins="${executedAmount} ${baseTicker}"`)
	
		const order = await binance.sellLimitOrder({
			symbol,
			amount: executedAmount,
			clientOrderId: clientOrderId,
			limitPrice: takeProfit
		})
		
		logger.info(`[Take Profit] status="${order.status}" camp.name="${name}" orderId="${order.orderId}" sellCoins="${executedAmount} ${baseTicker}"`)
	
		await handleOrderUpdate({ strategy, campaignId, order })
		
		if (order.status === 'placed') {
			watchOrderTillFill({ strategy, orderId: order.orderId, campaignId })
		}

		return order
	}
}

const binanceHasWeightLeft = () => {
	const usedWeight = binance.client.usedWeight()
	const weightLeft = MAX_BINANCE_WEIGHT - Number(usedWeight)
	const timeTillReset = (60 - new Date().getSeconds()) * 1000

	return {
		timeTillReset,
		weightLeft
	}
}

/**
 * Get order from binance
 * 
 * @param {String} orderId binance order id
 * @param {String} symbol BTCBUSD
 * @returns {Object}
 */
export const getBinanceOrder = (orderId, symbol) => binance.getOrder({ symbol, orderId })

/**
 * 
 * @note
 * 2 req weight per get status
 * 1000ms wait time = (60*2) 120 req/min = 10 possible req before rate limit
 * 2000ms wait time = (30*2) 60 req/min = 20 possible req before rate limit
 * 
 * @param {Object} params
 * @param {Number} retry how many times to retry if failed
 */
export const watchOrderTillFill = async ({ strategy, orderId, campaignId, payload = {} }, retry = 1) => {
	const maxRetries = 10
	const args = { strategy, orderId, campaignId, payload }
	const rerun = () => watchOrderTillFill(args)
	const { weightLeft, timeTillReset } = binanceHasWeightLeft()
	const waitTime = !weightLeft
		? timeTillReset
		: 1500
	
	if (!weightLeft) {
		logger.warn(`[Watch Order] binance has no weight left. timeTillReset="${timeTillReset / 1000} sec" orderId="${orderId}"`)
	}

	if (!orderId) {
		logger.error(`[Watch Order] orderId is required`)
		return
	}
		
	try {
		const order = await getBinanceOrder(orderId, strategy.pair)
	
		if (order.status === 'filled' || order.status === 'cancelled') {
			await handleOrderUpdate({
				strategy,
				campaignId,
				order
			})
		} else {
			setTimeout(rerun, waitTime)
		}

		// if we fulfilled buy order then sell it for takeprofit/stoploss
		if (order.side === 'buy' && order.status === 'filled') {
			const { takeProfit, stopLoss } = payload
			
			await handleTakeProfit({ strategy, order, takeProfit, campaignId })
			await handleStopLoss({ strategy, stopLoss, campaignId })
		}
	} catch (e) {
		logger.error(`[Watch Order] orderId="${orderId}" pair="${strategy.pair}" error="${e.message || e.body || e}" stack="${e.stack}" retry="${retry}" waitTime="${waitTime / 1000} sec"`)

		if (retry < maxRetries) {
			setTimeout(() => watchOrderTillFill(args, retry + 1), waitTime)
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
		let expectancy = null
		let expectancyValue = 0
		let winRate = 0
		
		// calculate expectancy
		if (pastTrades.length) {
			const pastWinningTrades = pastTrades.filter(trade => trade.profitLoss >= 0)
			const pastLosingTrades = pastTrades.filter(trade => trade.profitLoss < 0)
			winRate = (pastWinningTrades.length / pastTrades.length) || 0

			const avgWin = pastWinningTrades.reduce((acc, trade) => acc + trade.profitLoss, 0) / pastWinningTrades.length
			const avgLoss = pastLosingTrades.reduce((acc, trade) => acc + trade.profitLoss, 0) / pastLosingTrades.length
			expectancyValue = (winRate * avgWin) - ((1 - winRate) * avgLoss)
			expectancyValue = round(expectancyValue) || 0
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
			winRate: round(winRate * 100)
		})
	} catch (e) {
		logger.error(`[Create Trade] error="${e.message || e.body || e}" stack="${e.stack}"`)
	}
}

const handleCampaignFilledOrder = async ({ campaignId, order }) => {
	let campaignUpdate = {}
	const { initialBalance, balance, name } = await Campaigns.findById(campaignId)

	try {
		const { total, executedAmount } = order

		if (!total || isNaN(total)) {
			logger.error(`[Campaign Balance] Order total isn't a valid number total="${total}" order="${JSON.stringify(order)}"`)
		}
		
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
			const minBalance = 10.5
			
			campaignUpdate = {
				balance: newBalance,
				coinSymbol: null,
				coinAmount: 0,
				profitLoss,
				profitLossPerc: profitLossPerc,
				tradePlan: null,
				activeOrder: null
			}

			// Binance min purchase is $10 + 0.2% fees
			if (newBalance < minBalance) {
				campaignUpdate.status = 'inactive'

				logger.warn(`[Campaign Balance] Paused camp.name="${name}" balance="${newBalance}" because it has funds lower than minBalance="${minBalance}"`)
			}

			logger.info(`[Campaign Balance] Camp Name="${name}" Initial Balance="${initialBalance}" Balance="${newBalance}" Profit Loss="$${profitLoss} (${profitLossPerc} %)"`)
		}
		
		await Campaigns.updateOne({
			_id: campaignId
		}, campaignUpdate)
	} catch (e) {
		logger.error(`[Campaign Balance] order="${order}" error="${e.message || e.body || e}" stack="${e.stack}"`)
	}	
}

const handleOrderUpdate = async ({ strategy, campaignId, order }) => {
	const { status, side, orderId, clientOrderId } = order
	const baseTicker = getBaseTicker(order.symbol)
	const orderExists = !!(await Orders.findOne({
		status,
		clientOrderId,
		orderId,
		side,
	}, { _id: 1 }))

	logger.info(`[Order Update] status="${status}" side="${side}" amount="${order.orderAmount} ${baseTicker}" price="${order.executedPrice || order.orderPrice}" reason="${order.reason || ''}" orderId="${orderId}"`)

	if (!orderExists) {
		await Orders.create({
			campaignId,
			...order
		})
		
		strategy.setOrderStatus(side, status)
	} else {
		logger.warn(`[Watch Order] order already exists orderId="${orderId}"`)

		return
	}

	if (status !== 'cancelled') {
		await Campaigns.updateOne({
			_id: campaignId
		}, {
			activeOrder: order
		})
	} else if (status === 'cancelled' && side === 'buy') {
		await Campaigns.updateOne({
			_id: campaignId
		}, {
			activeOrder: null,
			tradePlan: null
		})
	}

	if (status === 'filled') {
		await handleCampaignFilledOrder({ order, campaignId })
		
		if (side === 'sell') {
			await createTrade({ order, campaignId })
		}
	}
}

export const handleBuy = async ({ payload, strategy, campaignId }) => {
	const { currentCandle, entryPrice, takeProfit, stopLoss, possibleProfit, possibleLoss } = payload
	const campaign = await Campaigns.findById(campaignId)
	const { balance, quoteCurrency, activeOrder, name } = campaign
	const possibleProfitInUsd = round(balance * (possibleProfit / 100))
	const possibleLossInUsd = round(balance * (possibleLoss / 100))

	logger.info(`[Buy] camp.name="${name}" currentCandle="${currentCandle.openDate.toJSON()}" entryPrice="${entryPrice}" takeProfit="${takeProfit}" stopLoss="${stopLoss}" possibleProfit="$${possibleProfitInUsd} (${possibleProfit}%)" possibleLoss="$${possibleLossInUsd} (${possibleLoss}%)" balance="${balance} ${quoteCurrency}"`)

	if (activeOrder?.status === 'placed') {
		logger.warn(`[Buy] camp.name="${name}" Failed to place an order as one is already placed - watching order instead`)

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
		const { activeOrder, name } = await Campaigns.findOne({ _id: campaignId })
		
		if (!activeOrder) {
			logger.warn(`[Sell] No active order found campaignId="${campaignId}" camp.name="${name}" `)

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

		logger.info(`[Sell] activeOrder="${orderId}" amount="${orderAmount} ${baseTicker}" camp.name="${name}"`)
		
		// Cancel takeProfit order if it exists
		if (side === 'sell' && status === 'placed') {
			logger.info(`[Sell] cancelling take profit order orderId="${orderId}" camp.name="${name}" `)

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
	const { activeOrder, name } = await Campaigns.findById(campaignId)

	if (!activeOrder) {
		logger.warn(`[Cancel Order] No active order found campaignId="${campaignId}" camp.name="${name}" `)

		return
	}
	
	const { status, orderId, clientOrderId, symbol } = activeOrder

	if (status === 'placed') {
		logger.info(`[Cancel Order] orderId="${orderId}" symbol="${symbol}" camp.name="${name}" `)

		const binanceOrder = await getBinanceOrder(orderId, strategy.pair)
		
		if (binanceOrder.status === 'placed') {
			const order = await binance.cancelOrder({
				symbol,
				orderId,
				clientOrderId
			})

			await handleOrderUpdate({ strategy, campaignId, order })
	
			return order
		} else {
			return binanceOrder
		}
	} else {
		logger.warn(`[Cancel Order] couldn't cancel an active order - activeOrder="${activeOrder}" camp.name="${name}" `)

		return activeOrder
	}
}
