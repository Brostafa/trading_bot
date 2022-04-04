import mongoose from './db.mjs'

const Trade = new mongoose.Schema({
	tradeId: Number,
	price: Number,
	amount: Number,
	side: {
		type: String,
		enum: ['buy', 'sell']
	},
	// BUSD|USDT|BNB
	feeCurrency: String,
	// BNB
	feeRealCurrency: String,
	feeRealAmount: Number,
	feelAmount: Number,
	filledAt: Number,
	takerOrMaker: {
		type: String,
		enum: ['taker', 'maker']
	}
}, {
	_id: false
})

export const OrderSchmea = new mongoose.Schema({
	campaignId: mongoose.Schema.Types.ObjectId,
	clientOrderId: String,
	orderId: String,
	status: {
		type: String,
		enum: ['cancelled', 'placed', 'filled']
	},
	symbol: String,
	orderPrice: Number,
	execuedPrice: Number,
	orderAmount: Number,
	executedAmount: Number,
	submittedAt: Number,
	filledAt: Number,
	side: {
		type: String,
		enum: ['buy', 'sell']
	},
	type: String,
	reason: String,
	remainingAmount: Number,
	fee: Number,
	trades: [Trade],
	// orderPrice * orderAmount
	cashAmount: Number,
	// Buy orderPrice * orderAmount + fee
	// Sell orderPrice * orderAmount - fee
	total: Number,

}, {
	timesamps: true
})

// connect mongoose schema with model
const Orders = mongoose.model('orders', OrderSchmea)

export default Orders