// Create a logging instance

import Logger from 'signale'

const loggerOptions = {
	config: {
		displayDate: true,
		displayTimestamp: true,
		displayBadge: false,
		displayScope: false
	}
}

const logger = new Logger.Signale(loggerOptions)

export default logger
