const { Client, GatewayIntentBits } = require("discord.js");
const { connectDB } = require("./database/database");
const { ChangeTypeAlert, checkProducts, checkHotProducts } = require("./scraper/scraper.js");
const PageError = require('./errors/PageError');
const HighTrafficError = require('./errors/HighTrafficError');
const { 
	HOT_DAYS,
	HOT_HOURS_RANGE,
	CHECK_INTERVAL_PEAK, 
	CHECK_INTERVAL_OFF_PEAK, 
	CHECK_INTERVAL_SNOOZE, 
	PROD_CHANNEL_ID, 
	TEST_CHANNEL_ID 
} = require("./config");
require("dotenv").config();

const MAX_JITTER_MS = 10 * 1000;
const MAX_CONSECUTIVE_FAILURES = 5;
let mode = "prod";
let consecutiveFailures = 0;

const client = new Client({
	intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
});

client.once("ready", async () => {
	console.log(`Logged in as ${client.user.tag}!`);
	await connectDB();

	const args = process.argv.slice(2);
	if (args.length > 0 && args[0] === "test") {
		mode = "test";
	} else {
		sendStartupStatusAlert();
	}
	console.log(`[INFO] App running in ${mode}`);
	console.log("────────────────────────────────────────────");

	const CHANNEL_ID = mode === "test" ? TEST_CHANNEL_ID : PROD_CHANNEL_ID;

	// start the infinite loop
	monitor({ channelId: CHANNEL_ID, mode });
});

client.login(process.env.BOT_TOKEN);

// helper: wait for N ms
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// helper: fetch channel and error if not found
async function getChannel(CHANNEL_ID) {
	const channel = await client.channels.fetch(CHANNEL_ID);
	if (!channel) throw new Error("❌ Channel not found!");
	return channel;
}

function formatPrice(rawPrice) {
	let dollars = Math.floor(rawPrice / 100);
	let cents = rawPrice % 100;
	return `$${dollars}.${cents}`;
}

function getInterval(now) {
	const hour = now.getHours();
	const day = now.getDay();
	const isHotTime = HOT_DAYS.includes(day) &&
		hour >= HOT_HOURS_RANGE.start &&
		hour < HOT_HOURS_RANGE.end;

	if (isHotTime) return { interval: CHECK_INTERVAL_PEAK, mode: 'throttle' };

	const timeToStart = HOT_HOURS_RANGE.start - hour;
	const timeToEnd = HOT_HOURS_RANGE.end - hour;

	if (HOT_DAYS.includes(day) && Math.abs(timeToStart) <= CHECK_INTERVAL_OFF_PEAK) {
		return { interval: timeToStart, mode: 'prep' };
	} else if (HOT_DAYS.includes(day) && (Math.abs(timeToStart) <= 2 || Math.abs(timeToEnd) <= 2)) {
		return { interval: CHECK_INTERVAL_OFF_PEAK, mode: 'standby' };
	} else {
		return { interval: CHECK_INTERVAL_SNOOZE, mode: 'snooze' };
	}
}

async function monitor({ channelId, mode }) {
	while (true) {
		// determine what mode to run scraper in
		const { interval: CHECK_INTERVAL, mode: runMode } = getInterval(new Date());
		console.log(`Bot running in ${runMode} mode`);

		try {
			let alertProducts = [];

			if (runMode === 'throttle') {
				alertProducts = await checkHotProducts();
			} else {
				alertProducts = await checkProducts();
			}

			consecutiveFailures = 0; // reset after successful scrape
			console.log(`sending alerts for ${alertProducts.length}`);

			// send alert for each changed/new/restocked product
			for (const [product, changeType, imgUrl] of alertProducts) {
				await sendAlert(product, changeType, imgUrl, channelId);
			}
		} catch (e) {
			// log error
			if (e instanceof PageError) {
				consecutiveFailures++;
				console.log("❌ Page error:", e.message);
			} else if (e instanceof HighTrafficError) {
				// probable restock in progress, warn users and sleep
				await sendTrafficAlert(channelId);
				const sleepTime = 1800000; // 30 min
				console.log(`High Traffic - retrying in ${sleepTime / 1000}s...`);
				await sleep(sleepTime);
			} else {
				consecutiveFailures++;
				console.log("❌ Other error:", e.message);
			}

			// alert admin of bot death
			if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
				try {
					const channel = await getChannel(TEST_CHANNEL_ID);
					const embed = {
						errorMessage: "Too many consecutive issues",
						timestamp: new Date(),
					}

					await channel.send({
						content: "Monitor Error -- Stopping Bot",
						embeds: [embed],
					});
				} finally {
					throw new Error("🚨 Too many consecutive failures. Exiting monitor.");
				}
			}

			const RETRY_DELAY = 10_000; // retry after 10s
			console.log(`Retrying in ${RETRY_DELAY / 1000}s... (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})`);
			await sleep(RETRY_DELAY);
			continue;
		}

		const jitter = Math.floor(Math.random() * MAX_JITTER_MS);
		const nextInterval = CHECK_INTERVAL + jitter;
		console.log(`Waiting ${nextInterval}ms before next scrape...\n`);
		await sleep(nextInterval);
	}
}

async function sendAlert(product, changeType, imgUrl, CHANNEL_ID) {
	try {
		const channel = await getChannel(CHANNEL_ID);

		let messageContent = "";
		switch (changeType) {
			case ChangeTypeAlert.RESTOCK:
				messageContent = `🔥 **${product.name}** is back in stock!`;
				break;
			case ChangeTypeAlert.NEW_ITEM:
				messageContent = `‼️ New product: **${product.name}**`;
				break;
			case ChangeTypeAlert.SOLD_OUT:
				messageContent = `📦 **${product.name}** has been SOLD OUT`;
				break;
			case ChangeTypeAlert.PRICE_CHANGE:
				messageContent = `💲 **${product.name}** has had a price change!`;
				break;
			default:
				messageContent = `❗ System Alert: ${product.name}`;
				break;
		}

		const embed = {
			title: product.name,
			url: product.url,
			fields: [
				{
					name: "Price",
					value: formatPrice(product.price),
					inline: true
				},
				{
					name: "Stock",
					value: product.in_stock ? "In Stock" : "Out of Stock",
					inline: true
				}
			],
			footer: {
				text: "PopMonitor",
			},
			timestamp: new Date(),
		};

		if (imgUrl) {
			embed.image = { url: imgUrl };
		}

		await channel.send({
			content: messageContent,
			embeds: [embed],
		});

		console.log("✅ Alert sent for:", product.name);
	} catch (e) {
		console.error("❌ Error sending alert:", e.message);
	}
}

async function sendStartupStatusAlert() {
	try {
		const channel = await getChannel(TEST_CHANNEL_ID);

		await channel.send({
			content: "Bot now running ✅"
		});
	} catch (e) {
		console.error("❌ Error sending startup alert:", e.message);
	}
}

async function sendTrafficAlert(CHANNEL_ID) {
	try {
		const channel = await getChannel(CHANNEL_ID);

		await channel.send({
			content: "",
			embeds: [
				{
					title: "❕ High Traffic Alert ❕",
					description: `Pop Mart is continuing to/just experiencing unusually high traffic.\n Potential Restock! Check the site manually.`,
					color: 0xffcc00, // yellaur
					footer: {
						text: "PopMonitor",
					},
					timestamp: new Date(),
				},
			],
		});

		console.log("✅ High traffic alert sent");
	} catch (e) {
		console.error("❌ Error sending traffic alert:", e.message);
	}
}
