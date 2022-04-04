import mongoose from './db.mjs'

const ObjectId = mongoose.Schema.Types.ObjectId

// create TradeSchemma
const TradeSchema = new mongoose.Schema({
	campaignId: ObjectId,
	buyOrderId: ObjectId,
	sellOrderId: ObjectId,
	clientOrderId: String,
	profitLoss: Number,
	fees: Number,
	expectancy: {
		profitLosses: [Number],
		value: Number
	},
	winRate: Number
}, {
	timestamps: true
})

// connect mongoose schema with model
const Trades = mongoose.model('trades', TradeSchema)

export default Trades