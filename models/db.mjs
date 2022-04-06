import mongoose from 'mongoose'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import logger from '../logger.mjs'

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

import { config } from 'dotenv'
config({
	path: join(__dirname, '../.env')
})

mongoose.connect(process.env.MONGO_URL).catch(e => {
	logger.error(e)
	process.exit(1)
})

export default mongoose