const { MetadataStorage } = require("@medusajs/framework/mikro-orm/core")

if (process.env.DATABASE_URL) {
	const databaseUrl = new URL(process.env.DATABASE_URL)

	process.env.DB_HOST ||= databaseUrl.hostname
	process.env.DB_PORT ||= databaseUrl.port
	process.env.DB_USERNAME ||= decodeURIComponent(databaseUrl.username)
	process.env.DB_PASSWORD ||= decodeURIComponent(databaseUrl.password)
}

MetadataStorage.clear()