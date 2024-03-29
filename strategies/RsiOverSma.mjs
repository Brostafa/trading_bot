import { RSI, SMA } from 'technicalindicators'
import { addDays } from 'date-fns'
import { PublicBinance, getTickSize, pricePercision, quotePercision, round } from '../exchanges/Binance.mjs'


const RSI_UPPER_BAND = 60
const RSI_LOWER_BAND = 35
const RSI_PERIOD = 14
const SMA_PERIOD = 14
const CROSS_OVER_THRESHOLD = 0.5
const MINIMUM_PROFIT = 0.5 // 0.5%
const RISK_REWARD = 1 / 1.1 // 1.1x
const MINIMUM_BULLISH_CHANGE = 2 // 2%

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

export default class Strategy {
	constructor ({
		pair,
		startTime,
		endTime,
		manualSetCandles = false,
	 }) {
		this.pair = pair
		this.startTime = startTime
		this.endTime = endTime
		this.manualSetCandles = manualSetCandles
		this.binance = new PublicBinance()
		this.tickSize = getTickSize(pair)

		this.bullishCandle = null
		// bullish candle low
		this.support = null
		// bullish candle high
		this.resistance = null
		this.done = false
		this.reason = null
		this.candles = []
		this.nextAction = 'wait_buy_signal'
		this.tradePlan = {
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
				endTime: this.endTime,
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
		
		return delay(msLeft)
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
				this.nextAction = 'wait_buy_signal'
			} else {
				throw new Error('Invalid order status')
			}
		} else {
			if (status === 'placed' || status === 'cancelled') {
				this.nextAction = 'wait_for_exit'
			} else if (status === 'filled') {
				this.nextAction = 'wait_buy_signal'
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
				payload: {
					currentCandle,
				}
			}
		}

		if (currentCandle && Date.now() + 1000 > this.endTime) {
			this.done = true
			this.reason = 'End time reached'
			const { nextAction } = this
			const actionMap = {
				'wait_for_entry': 'cancel_buy',
				'wait_for_sell_order': 'sell',
				'wait_for_exit': 'sell'
			}

			let action = actionMap[nextAction]

			if (action) {
				return {
					action,
					payload: {
						currentCandle,
						reason: 'end_of_day'
					}
				}
			}

			return {
				action: 'end',
				payload: {
					currentCandle,
					reason: 'end_of_day'
				}
			}
		}

		if (this.nextAction === 'wait_buy_signal') {
			const rsi = new RSI.calculate({
				period: RSI_PERIOD,
				values: this.candles.map(c => c.close),
			})
	
			const rsiSma = new SMA.calculate({
				period: SMA_PERIOD,
				values: rsi
			})

			// RSI crossover settings
			const currentRsi = rsi[rsi.length - 1]
			const prevRsi = rsi[rsi.length - 2]
			const currentSma = rsiSma[rsiSma.length - 1]
			const prevSma = rsiSma[rsiSma.length - 2]
			const rsiInRange = currentRsi > RSI_LOWER_BAND && currentRsi < RSI_UPPER_BAND
			const rsiCrossedOver = currentRsi - currentSma > CROSS_OVER_THRESHOLD && prevRsi - prevSma < CROSS_OVER_THRESHOLD

			// Can enter the market
			const { high, close } = currentCandle
			
			let entryPrice = high + this.tickSize
			entryPrice = pricePercision(this.pair, entryPrice)
			const entryHigherThanSupport = entryPrice > this.support + this.tickSize
			const entryLowerThanResistance = entryPrice < this.resistance - this.tickSize
			const validEntry = rsiInRange && rsiCrossedOver && entryHigherThanSupport && entryLowerThanResistance
			
			if (validEntry) {
				const possibleProfit = round((this.resistance - 2 * this.tickSize - high) / close * 100)

				if (possibleProfit > MINIMUM_PROFIT) {
					let takeProfit = this.resistance - this.tickSize
					takeProfit = pricePercision(this.pair, takeProfit)
					const risk = entryPrice - ((takeProfit - entryPrice) * RISK_REWARD)
					let stopLoss = Math.max(this.support - this.tickSize, risk)
					stopLoss = pricePercision(this.pair, stopLoss)
					const possibleLoss = round((entryPrice - stopLoss) / close * 100)
					const payload = {
						currentCandle,
						entryPrice,
						takeProfit,
						stopLoss,
						possibleProfit,
						possibleLoss,
						reason: 'rsi_crossed_over',
					}

					this.nextAction = 'wait_for_entry'
					this.tradePlan = {
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
			const { stopLoss, takeProfit } = this.tradePlan
			const stopLossReached = low <= stopLoss
			const takeProfitReached = high >= takeProfit

			if (stopLossReached || takeProfitReached) {
				this.nextAction = 'wait_buy_signal'

				return {
					action: 'cancel_buy',
					payload: {
						currentCandle,
						stopLossReached,
						takeProfitReached,
						stopLoss,
						takeProfit,
						reason: stopLossReached ? 'stop_loss_reached' : 'take_profit_reached',
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