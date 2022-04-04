import mongoose from './db.mjs'

const ActiveOrder = new mongoose.Schema({
	status: {
		type: String,
		enum: ['cancelled', 'placed', 'filled']
	},
	orderPrice: Number,
	symbol: String,
	orderId: String,
	clientOrderId: String,
	submittedAt: Number,
	filledAt: Number,
	side: {
		type: String,
		enum: ['buy', 'sell']
	},
	type: String,
	reason: String,
	executedAmount: Number,
	executedPrice: Number,
	orderAmount: Number,
	remainingAmount: Number
}, {
	_id: false
})

const Candle = new mongoose.Schema({
	openDate: Date,
	openTime: Number,
	open: Number,
	high: Number,
	low: Number,
	close: Number,
	closeDate: Date,
	closeTime: Number,
	volume: Number
}, {
	_id: false
})

const TradePlan = new mongoose.Schema({
	entryPrice: Number,
	takeProfit: Number,
	stopLoss: Number,
	possibleProfit: Number,
	currentCandle: Candle
})

// create mongoose schema
const CampaignSchema = new mongoose.Schema({
	name: String,
	initialBalance: {
		type: Number,
		required: true
	},
	balance: {
		type: Number,
		required: true
	},
	activeOrder: ActiveOrder,
	tradePlan: TradePlan,
	strategyName: {
		type: String,
		enum: ['RSI_OVER_SMA'],
		default: 'RSI_OVER_SMA'
	},
	baseCurrency: {
		type: String,
		enum: ['USDT', 'BUSD', 'USDC'],
		default: 'BUSD'
	},
	coinSymbol: String,
	coinAmount: Number,
	profitLoss: Number,
	profitLossPerc: Number,
	status: {
		type: String,
		enum: ['active', 'inactive'],
		default: 'active'
	},
}, {
	timestamps: true
})

// connect mongoose schema with model
const Campaigns = mongoose.model('campaigns', CampaignSchema)

export default Campaigns