import mongoose from './db.mjs'

// create mongoose schema
const EventSchema = new mongoose.Schema({
	campaignId: mongoose.Schema.Types.ObjectId,
	action: String,
	payload: mongoose.Schema.Types.Mixed
}, {
	timestamps: true
})

// connect mongoose schema with model
const Events = mongoose.model('events', EventSchema)

export default Events