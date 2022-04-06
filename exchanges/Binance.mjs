/**
 * Binance Exchange
 * 
 * Pair: BTC/USDT (CakeUp naming convention)
 * Symbol: BTCUSDT (Exchange naming convention)
 * 
 * - BTC/USD
 *   Base/Quote
 * 
 * For 9xx errors (e.g: LOT_SIZE, PRICE_FILTER)
 * https://binance-docs.github.io/apidocs/spot/en/#9xxx-filter-failures
 * 
 */
// const Client = require('node-binance-api')
import Client from 'node-binance-api'
import EventEmitter from 'events'
import logger from '../logger.mjs'

import { v4 } from 'uuid'

const randomClientOid = v4

const getBinancePairs = async () => {
  const client = new Client().options({
    APIKEY: '',
    APISECRET: ''
  })

  const { symbols } = await client.exchangeInfo()

  // reduce symbols using symbol prop as key
  const pairs = symbols.reduce((collection, symbol) => {
    const { symbol: pair, filters } = symbol
    const priceFilter = filters.filter(f => f.filterType === 'PRICE_FILTER')[0].tickSize
    const lotSize = filters.filter(f => f.filterType === 'LOT_SIZE')[0].stepSize
    
    collection[pair] = {
      pair,
      priceFilter,
      lotSize
    }

    return collection
  }, {})

  return pairs
}

const _symbolFilters = () => {
  let pairs = {}
  
  getBinancePairs()
  .then(res => {
    pairs = res
    logger.info(`[Binance] Loaded symbols ${Object.keys(pairs).length} pairs`)
  }).catch(e => {
    logger.error(`[Binance] Error getting symbol filters ${e}`)
    process.exit(0)
  })

  return symbol => pairs[symbol]
}

const symbolFilters = _symbolFilters()


/**
 * Get ticksize for a symbol
 * 
 * @example
 * getTickSize('XRPBUSD')
 * 0.0001
 * 
 * @param {String} symbol symbol (e.g: LTCBUSD)
 * @returns {Number} tickSize (e.g: 0.01)
 */
export const getTickSize = symbol => {
  const { priceFilter } = symbolFilters(symbol)
  
  return parseFloat(priceFilter)
}

const percision = (price, step) => {
  const percision = String(parseFloat(step)).split('.')[1].length
  
  return Math.floor(price * Math.pow(10, percision)) / Math.pow(10, percision)
}

/**
 * Floor price to tickSize
 * 
 * @example
 * pricePercision('LTCBUSD', 120.276)
 * 120.2
 * 
 * @param {String} symbol BTCUSDT
 * @param {Number} price 
 * @returns {Number} price rounded to tickSize
 */
export const pricePercision = (symbol, price) => {
  const { priceFilter } = symbolFilters(symbol)

  return percision(price, priceFilter)
}

export const quotePercision = (symbol, price) => {
  const { lotSize } = symbolFilters(symbol)

  return percision(price, lotSize)
}

/**
 * Transform symbol to pair
 * 
 * @example
 * symbolToPair('BTCUSDT')
 * // BTC/USDT
 * 
 * @param {String} symbol BTCUSDT baseQuote
 * @returns {String} pair BTC/USDT base/quote
 */
const symbolToPair = symbol => {
  // Keep USD at the end of the array so we check for USDT first
  const popularQuotes = ['EUR', 'AUD', 'USDT', 'BUSD', 'USDC',  'BNB', 'BTC', 'ETH', 'SOL', 'SHIB', 'BIDR', 'USD']

  for (const quote of popularQuotes) {
    const quoteIndex = symbol.search(quote)
    const [base, ...rest] = symbol.split(quote)
    const restOfSymbol = quote + rest

    // quote is the base
    if (quoteIndex === 0) {
      return `${restOfSymbol}/${base}`
    } else if (quoteIndex > 0) {
      return `${base}/${restOfSymbol}`
    }
  }

  const quote = symbol.slice(-3)
  const coin = symbol.replace(quote, '')
  const pair = (coin + '/' + quote).toUpperCase()

  return pair
}

export const getBaseTicker = symbol => symbolToPair(symbol).split('/')[0]

const normalizeResponse = (type, response) => {
  const r = response
  
  if (type === 'order') {
    // https://binance-docs.github.io/apidocs/spot/en/#public-api-definitions
    const cancelledStatuses = ['CANCELED', 'PENDING_CANCEL', 'REJECTED', 'EXPIRED']
    let status = cancelledStatuses.includes(r.status)
      ? 'cancelled' 
      : r.status === 'FILLED'
        ? 'filled'
        : 'placed'
    
    let reason

    if (status === 'cancelled') {
      switch (r.status) {
      case 'CANCELED':
        reason = 'The order has been canceled by the user.'
        break;
      case 'REJECTED':
        reason = 'Rejected - The order was not accepted by the engine and not processed.'
        break;
      case 'EXPIRED':
        reason = 'The order was canceled according to the order type\'s rules (e.g. LIMIT FOK orders with no fill, LIMIT IOC or MARKET orders that partially fill) or by the exchange, (e.g. orders canceled during liquidation, orders canceled during maintenance)'
        break;
      }
    }

    let structuredResponse = {
      status,
      symbol: r.symbol,
      orderId: r.orderId,
      clientOrderId: r.clientOrderId,
      submittedAt: r.time || r.transactTime,
      filledAt: status === 'filled' ? r.updateTime : null,
      side: r.side.toLowerCase(),
      type: r.type.toLowerCase(),
      reason,
      executedAmount: Number(r.executedQty),
      orderAmount: Number(r.origQty),
      remainingAmount: Number(r.origQty) - Number(r.executedQty || 0)
    }

    if (Number(r.price)) {
      structuredResponse.orderPrice = Number(r.price)
    }

    return structuredResponse
  } else if ( type === 'order-error' ) {
    const { orderOpts, message } = r
    const {
      symbol,
      side,
      amount: orderAmount,
      flags,
    } = orderOpts
    const { type, newClientOrderId } = flags

    return {
      status: 'cancelled',
      symbol,
      submittedAt: new Date(),
      side,
      type,
      reason: message,
      orderAmount,
      clientOrderId: newClientOrderId,
    }
  } else if (type === 'ws-ticker') {
    const coinPairs = Object.keys(r).reduce((collection, symbol) => {
      const { close, eventTime: time } = r[symbol]

      collection[symbol] = {
        time,
        symbol,
        price: Number(close)
      }

      return collection
    }, {})

    return coinPairs
  }
}

export const round = price => price ? Math.round(Number(price) * 100) / 100 : price


export class Binance {
  constructor ({ apiKey, apiSecret, sandbox = false, isUs = false }) {
    let opts = {}

    // If sandbox=true and isUs=true then we will use normal
    // sandbox API as us doesn't have sandbox version
    if (sandbox) {
      opts = {
        urls: {
          base: 'https://testnet.binance.vision/api/'
        }
      }
    } else if (isUs) {
      opts = {
        urls: {
          base: 'https://api.binance.us/api/',
          wapi: 'https://api.binance.us/wapi/',
          sapi: 'https://api.binance.us/sapi/'
        }
      }
    }

    this.client = new Client({
      APIKEY: apiKey,
      APISECRET: apiSecret,
      ...opts
    })
  }


  /**
   * Get symbol price without fees
   * @param {String} symbol BTC/USDT
   */
   async getSymbolPrice (symbol) {
    const data = await this.client.avgPrice(symbol)
    const price = data[symbol]

    return Number(price)
  }

  async getBalance (currency = 'USDT') {
    // {
    //   BTC: { available: '0.00000120', onOrder: '0.00000000' },
    //   ...  
    // }
    const balances = await this.client.balance()

    for (let balanceTicker in balances) {
      if (balanceTicker === currency) {
        const balance = balances[balanceTicker]

        return Number(balance.available)
      }
    }
  }
  
  /**
   * @async
   * Get quoteAmount from an asset.
   * It solves the question of "How much 0.5 BTC in USDT?". You can
   * also pass a timestamp to get quoteAmount in a previous time
   * 
   * @example
   * await getQuoteAmount({
   *   assetTicker: 'BTC',
   *   assetAmount: 0.5,
   *   quoteTicker: 'USDT',
   * })
   * 58557.45 
   *
   * 
   * @param {Object} options
   * @param {String} options.assetTicker
   * @param {Number} options.assetAmount
   * @param {String} options.quoteTicker
   * @param {Number} [options.timestamp]
   */
  async getQuoteAmount ({ assetTicker, assetAmount, quoteTicker, timestamp }) {
    // BTCUSDT
    const symbol = assetTicker + quoteTicker
    const oneMinute = 60000

    if (!timestamp || Date.now() - timestamp < oneMinute) {
      const pairPrice = await this.getSymbolPrice(symbol)

      return assetAmount * pairPrice
    }

    const [ firstCandle ] = await this.client.candlesticks(symbol, '1m', null, { limit: 1, startTime: timestamp })
    // eslint-disable-next-line
    const [ openTime, open ] = firstCandle

    return assetAmount * Number(open)
  }

  async normalizeTradeRes (response) {
    const r = response
    // Trade response -> https://binance-docs.github.io/apidocs/spot/en/#account-information-user_data
    // BTC or BNB,...etc
    const feeRealCurrency = r.commissionAsset
    const feeRealAmount = Number(r.commission)
    const feeCurrency = 'USDT'
    let feeAmount = feeRealCurrency === 'USDT' ? feeRealAmount : null 
  
    // If paid fee currency isn't usdt then we will
    // convert it to USDT
    if (feeRealCurrency !== 'USDT') {
      feeAmount = await this.getQuoteAmount({
        assetTicker: feeRealCurrency,
        assetAmount: feeRealAmount,
        quoteTicker: feeCurrency,
        timestamp: r.time
      })
    }
    
    return {
      tradeId: r.id,
      price: Number(r.price),
      amount: Number(r.qty),
      side: r.isBuyer ? 'buy' : 'sell',
      feeCurrency,
      feeRealCurrency,
      feeRealAmount,
      feeAmount,
      filledAt: r.time,
      takerOrMaker: r.isMaker ? 'maker' : 'taker'
    }
  }  

  async getTrades (orderId, symbol) {
    // https://binance-docs.github.io/apidocs/spot/en/#account-trade-list-user_data
    const res = await this.client.trades(symbol, null, {
      orderId,
    })

    const promises = res.map(trade => this.normalizeTradeRes(trade))
    const trades = await Promise.all(promises)
    
    return trades
  }

  getAmountFromTrades (trades) {
    return trades.reduce((amount, trade) => amount += Number(trade.amount), 0)
  }

  getWeightedPrice (trades) {
    const totalPaid = trades.map(a => Number(a.price) * Number(a.amount)).reduce((total, paid) => total + paid, 0)
    const amount = trades.reduce((total, trade) => total + Number(trade.amount), 0)

    return totalPaid / amount
  }

  async _structureOrder (orderRes) {
    const order = normalizeResponse('order', orderRes)
    const trades = await this.getTrades(order.orderId, order.symbol)
    const fee = Number(order.fee) || 0
    const roundFee = fee
      ? round(fee)
      : 0

    let total, cashAmount, price
    let { orderPrice } = order
    let tradeFees = 0

    if (trades.length) {
      const orderAmount = Number(order.orderAmount) || this.getAmountFromTrades(trades)
      tradeFees = trades.map(trade => Number(trade.feeAmount)).reduce((total, fee) => total + fee, 0)
      
      price = this.getWeightedPrice(trades)
      orderPrice = orderPrice || Number(trades[0].price)
      cashAmount = Number(price) * orderAmount
      total = order.side === 'buy'
        ? round(cashAmount + (fee || tradeFees))
        : round(cashAmount - (fee || tradeFees))
  
    }

    if (!order.filledAt && order.status === 'filled') {
      order.filledAt = trades.reduce((lastTradeTimestamp, trade) => Math.max(lastTradeTimestamp, trade.filledAt), 0)
    }

    return {
      ...order,
      fee: roundFee || round(tradeFees),
      trades,
      total,
      cashAmount,
      executedPrice: price,
      orderPrice
    }
  }
  
  async getOrder ({ orderId, symbol }) {
    const orderRes = await this.client.orderStatus(symbol, null, null, { orderId })

    if (!orderRes) return null
    
    return this._structureOrder(orderRes)
  }

  async _order (orderOpts) {
    const { side, symbol, amount, price, flags } = orderOpts
    let orderRes

    try {
      orderRes = await this.client.order(side, symbol, amount, price, flags)

      if (flags?.type === 'STOP_LOSS_LIMIT') {
        return await this.getOrder({ orderId: orderRes.orderId, symbol })
      }
    } catch (e) {
      const message = JSON.parse(e.body || '{}').msg || e.message

      return normalizeResponse('order-error', { orderOpts, message })
    }

    return this._structureOrder(orderRes)
  }
  
  async buyStopLimitOrder ({ symbol, balance, limitPrice }) {
    const balanceWithFee = balance * 0.999 // 0.1% for fees
    let amount = balanceWithFee / limitPrice
    amount = quotePercision(symbol, amount)
    
    const orderOpts = {
      side: 'buy',
      symbol,
      amount,
      price: limitPrice,
      flags: {
        stopPrice: limitPrice,
        newClientOrderId: randomClientOid(),
        type: 'STOP_LOSS_LIMIT',
        timeInForce: 'GTC',
      },
    }

    return this._order(orderOpts)
  }

  async sellMarketOrder ({ symbol, amount, clientOrderId }) {
    const orderOpts = {
      side: 'sell',
      symbol,
      amount,
      price: 0, // to indicate market order
      flags: {
        newClientOrderId: clientOrderId,
        type: 'MARKET'
      }
    }

    return this._order(orderOpts)
  }

  async sellLimitOrder ({ symbol, amount, clientOrderId, limitPrice }) {    
    const orderOpts = {
      side: 'sell',
      symbol,
      amount,
      price: limitPrice,
      flags: {
        newClientOrderId: clientOrderId,
        type: 'LIMIT',
        timeInForce: 'GTC',
      }
    }

    return this._order(orderOpts)
  }

  async cancelOrder ({ orderId, symbol, clientOrderId }) {
    const orderRes = await this.client.cancel(symbol, orderId, clientOrderId)

    return normalizeResponse('order', orderRes)
  }
}

export class PublicBinance {
  constructor ({ sandbox = false } = {}) {
    this.client = new Client().options({
      APIKEY: '',
      APISECRET: '',
      test: sandbox
    })

    this.websocketOpen = false
  }

  // https://github.com/jaggedsoft/node-binance-api#get-miniticker-via-websocket
  openWebsocket (callback) {
    if (this.websocketOpen) throw new Error('Binance websocket already open')
    
    this.client.websockets.miniTicker(markets => {
      const coinPairs = normalizeResponse('ws-ticker', markets)

      callback(coinPairs)
    })

    this.websocketOpen = true
  }

  async getCandles ({ symbol, interval, startTime, endTime, limit }) {
    const candles = await this.client.candlesticks(symbol, interval, null, { startTime, endTime, limit })
    
    return candles.map(c => ({
      openTime: c[0],
      openDate: new Date(c[0]),
      open: Number(c[1]),
      high: Number(c[2]),
      low: Number(c[3]),
      close: Number(c[4]),
      volume: Number(c[5]),
      closeTime: c[6],
      closeDate: new Date(c[6]),
    }))
  }
}

const publicClient = new PublicBinance()

class BinanceEmitter extends EventEmitter {}

export const binanceEmitter = new BinanceEmitter();

publicClient.openWebsocket((pairObjs) => {
  for (let pairObj of Object.values(pairObjs)) {
    const { time, symbol, price } = pairObj

    binanceEmitter.emit(symbol, { time, price, symbol })
  }
})
