import { RSI, SMA } from 'technicalindicators'
import { PublicBinance } from './Binance.mjs'
import { addDays } from 'date-fns'
import Promise from 'bluebird'
import logger from './logger.mjs'

const RSI_UPPER_BAND = 60
const RSI_LOWER_BAND = 35
const RSI_PERIOD = 14
const SMA_PERIOD = 14
const CROSS_OVER_THRESHOLD = 0.5
const MINIMUM_PROFIT = 0.5 // 0.5%
const RISK_REWARD = 1 / 1.1 // 1.1x
const MINIMUM_BULLISH_CHANGE = 2 // 2%

export default class Strategy {
	constructor ({
		pair,
		startTime,
		endTime,
		manualSetCandles = false,
		tickSize = 0.01,
	 }) {
		this.pair = pair
		this.startTime = startTime
		this.endTime = endTime
		this.manualSetCandles = manualSetCandles
		this.binance = new PublicBinance()
		this.tickSize = tickSize

		this.bullishCandle = null
		// bullish candle low
		this.support = null
		// bullish candle high
		this.resistance = null
		this.done = false
		this.reason = null
		this.candles = []
		this.nextAction = 'wait_for_cross_over'
		this.tradeOrder = {
			entryPrice: null,
			takeProfit: null,
			stopLoss: null,
			// ...other params
		}
	}

	getBullishCandle = async (retry = 1) => {
		let candles = []
		const maxRetries = 5

		try {
			candles = await this.binance.getCandles({
				symbol: this.pair,
				interval: '1d',
				limit: 1,
				startTime: this.startTime
			})
		} catch (e) {
			if (retry > maxRetries) {
				throw e
			}

			return this.getBullishCandle(retry + 1)
		}
	
		const { open, high, low, close } = candles[0]
		const candleChange = (high - low) / high * 100

		// If yesterday had bullish candle
		if (close >= open && candleChange > MINIMUM_BULLISH_CHANGE) {
			return {
				pair: this.pair,
				...candles[0]
			}
		}
	}

	async init () {
		const bullishCandle = await this.getBullishCandle()
	
		if (bullishCandle) {
			const { low, high } = bullishCandle
			this.bullishCandle = bullishCandle
			this.support = low
			this.resistance = high
		} else {
			this.done = true
			this.reason = 'No bullish candle'
		}
	}
	
	canRun () {
		return !this.done
	}

	async setCandles (limit = 1000, retry = 1) {
		const maxRetries = 5
		
		try {
			const candles = await this.binance.getCandles({
				symbol: this.pair,
				interval: '15m',
				startTime: this.startTime,
				endTime: new Date().getTime(),
				limit,
			})
	
			const lastCandle = candles.slice(-1)[0]

			if (lastCandle.closeTime > Date.now()) {
				// get rid of the live candle
				candles.splice(-1)
			}
			
			this.candles = candles
		} catch (e) {
			if (retry > maxRetries) {
				throw e
			}

			return this.setCandles(limit, retry + 1)
		}
	}

	waitNextCandle () {
		const minutesLeft = 15 - (new Date().getMinutes() % 15) - 1
		const secondsLeft = 60 - new Date().getSeconds()
		const msLeft = (minutesLeft * 60 * 1000 + secondsLeft * 1000) + 500
		
		return Promise.delay(msLeft)
	}

	getLastItem (array) {
		return array.slice(-1)[0]
	}

	setOrderStatus (side = 'buy', status = 'placed') {
		if (side === 'buy') {
			if (status === 'placed') {
				this.nextAction = 'wait_for_entry'
			} else if (status === 'filled') {
				this.nextAction = 'wait_for_sell_order'
			} else if (status === 'cancelled') {
				this.nextAction = 'wait_for_cross_over'
			} else {
				throw new Error('Invalid order status')
			}
		} else {
			if (status === 'placed' || status === 'cancelled') {
				this.nextAction = 'wait_for_exit'
			} else if (status === 'filled') {
				this.nextAction = 'wait_for_cross_over'
			} else {
				throw new Error('Invalid order status')
			}
		}
	}

	async run () {
		if (!this.manualSetCandles) {
			await this.setCandles()
		}

		const currentCandle = this.getLastItem(this.candles)
		const plusOneDay = addDays(new Date(this.startTime), 1)

		if (currentCandle && currentCandle.openTime < plusOneDay.getTime()) {
			return {
				action: 'wait_for_trade_time',
			}
		}

		if (currentCandle && currentCandle.openTime > this.endTime) {
			this.done = true
			this.reason = 'End time reached'

			return {
				action: 'sell',
				payload: {
					currentCandle
				}
			}
		}

		if (this.nextAction === 'wait_for_cross_over') {
			const rsi = new RSI.calculate({
				period: RSI_PERIOD,
				values: this.candles.map(c => c.close),
			})
	
			const rsiSma = new SMA.calculate({
				period: SMA_PERIOD,
				values: rsi
			})

			const currentRsi = rsi[rsi.length - 1]
			const prevRsi = rsi[rsi.length - 2]
			const currentSma = rsiSma[rsiSma.length - 1]
			const prevSma = rsiSma[rsiSma.length - 2]
			const rsiInRange = currentRsi > RSI_LOWER_BAND && currentRsi < RSI_UPPER_BAND
			const rsiCrossedOver = currentRsi - currentSma > CROSS_OVER_THRESHOLD && prevRsi - prevSma < CROSS_OVER_THRESHOLD
			
			if (rsiInRange && rsiCrossedOver) {
				const { high, close } = currentCandle
				const possibleProfit = (this.resistance - 2 * this.tickSize - high) / close * 100

				if (possibleProfit > MINIMUM_PROFIT) {
					const takeProfit = this.resistance - this.tickSize
					const entryPrice = high + this.tickSize
					const risk = entryPrice - ((takeProfit - entryPrice) * RISK_REWARD)
					const stopLoss = Math.max(this.support - this.tickSize, risk)
					const payload = {
						currentCandle,
						entryPrice,
						takeProfit,
						stopLoss,
						possibleProfit
					}

					this.nextAction = 'wait_for_entry'
					this.tradeOrder = {
						...payload
					}
					
					return {
						action: 'buy',
						payload
					}
				}
			}
		} else if (this.nextAction === 'wait_for_entry') {
			const { low, high } = currentCandle
			const { stopLoss, takeProfit } = this.tradeOrder
			const stopLossReached = low <= stopLoss
			const takeProfitReached = high >= takeProfit

			if (stopLossReached || takeProfitReached) {
				this.nextAction = 'wait_for_cross_over'

				return {
					action: 'cancel_buy',
					payload: {
						currentCandle,
						stopLossReached,
						takeProfitReached
					}
				}
			}
		}

		return {
			action: this.nextAction,
			payload: {
				currentCandle
			}
		}
	}
}