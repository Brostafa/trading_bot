import mongoose from 'mongoose'
import logger from '../logger.mjs'
import { config } from 'dotenv'
config()

mongoose.connect(process.env.MONGO_URL).catch(e => {
	logger.error(e)
	process.exit(1)
})

export default mongoose