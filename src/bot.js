const { Client, GatewayIntentBits } = require("discord.js");
const { connectDB } = require("./database/database");
const { checkProducts } = require("./scraper");
const PageError = require('./errors/PageError');
const { 
  HOT_DAYS,
  HOT_HOURS_RANGE,
  CHECK_INTERVAL_PEAK, 
  CHECK_INTERVAL_REG, 
  PROD_CHANNEL_ID, 
  TEST_CHANNEL_ID 
} = require("./config");
require("dotenv").config();

const MAX_JITTER_MS = 10 * 1000;
let mode = "prod"
let consecutiveFailures = 0;
let MAX_CONSECUTIVE_FAILURES = 5;

const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
});
client.login(process.env.BOT_TOKEN);

client.once("ready", async () => {
    console.log(`Logged in as ${client.user.tag}!`);
    await connectDB();
  
    var args = process.argv.slice(2);
    if (args.length > 0 && args[0] === "test") {
      mode = "test";
    } else {
      sendStartupStatusAlert();
    }
    console.log(`[INFO] App running in ${mode}`);
    console.log("────────────────────────────────────────────");
  
    let CHANNEL_ID = mode == "test" ? TEST_CHANNEL_ID : PROD_CHANNEL_ID;
  
    // start the infinite loop
    monitor(CHANNEL_ID);
  });
  
async function monitor(CHANNEL_ID) {
  while(true) {
    // check if we are in "hot" time & weekday, then we adjust which mode we run in
    let now = new Date();
    let curHour = now.getHours();
    let curDay = now.getDay();
    let isHotTime = HOT_DAYS.includes(curDay) &&
                      curHour >= HOT_HOURS_RANGE.start &&
                      curHour < HOT_HOURS_RANGE.end;
    let CHECK_INTERVAL = isHotTime ? CHECK_INTERVAL_PEAK : CHECK_INTERVAL_REG;

    try {
      let alertProducts = [];
      if(isHotTime) {
        alertProducts = await checkHotProducts();
      } else {
        alertProducts = await checkProducts();
      }

      consecutiveFailures = 0; // reset after successful scrape

      // send alert for each changed/new/restocked product
      for (const [product, changeType, imgUrl] of alertProducts) {
        await sendAlert(product, changeType, imgUrl, CHANNEL_ID);
      }
    } catch (e) {
      consecutiveFailures++;

      // log error
      if (e instanceof PageError) {
        console.log("❌ Page error:", e.message);
      } else {
        console.log("❌ Other error:", e.message);
      }

      // alert admin of bot death
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        await sendAlert({
          name: "Monitor Error",
          url: "https://www.popmart.com/us/",
        }, "error", TEST_CHANNEL_ID);

        throw new Error("🚨 Too many consecutive failures. Exiting monitor.");
      }

      const RETRY_DELAY = 10_000; // retry after 10s
      console.log(`⏳ Retrying in ${RETRY_DELAY / 1000}s... (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})`);
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
      continue;
    }
  
    const jitter = Math.floor(Math.random() * MAX_JITTER_MS);
    const nextInterval = CHECK_INTERVAL + jitter;
    console.log(`Waiting ${nextInterval}ms before next scrape...\n`);
    await new Promise(resolve => setTimeout(resolve, nextInterval));
  }
}

function formatPrice(rawPrice) {
    let dollars = Math.floor(rawPrice / 100);
    let cents = rawPrice % 100

    return `$${dollars}.${cents}`;
}

async function sendAlert(product, changeType, imgUrl, CHANNEL_ID) {
    try {
      const channel = await client.channels.fetch(CHANNEL_ID);
      if (!channel) {
        console.error("❌ Channel not found!");
        return;
      }
  
      const messageContent = changeType === 0 
        ? `🔥 **${product.name}** is back in stock!`
        : `‼️ New product: **${product.name}**`;
  
      await channel.send({
        content: messageContent,
        embeds: [
          {
            title: product.name,
            url: product.url,
            image: {
              url: imgUrl,
            },
            fields: [
              {
                name: "Price",
                value: formatPrice(product.price),
                inline: true,
              },
            ],
            footer: {
              text: "PopMonitor",
            },
            timestamp: new Date(),
          },
        ],
      });
  
      console.log("✅ Alert sent for: ", product.name);
    } catch (err) {
      console.error("❌ Error sending alert:", err.message);
    }
}

async function sendStartupStatusAlert() {
    try {
      const channel = await client.channels.fetch(TEST_CHANNEL_ID);
      if (!channel) {
        console.error("❌ Channel not found!");
        return;
      }
  
      await channel.send({
        content: "Bot now running ✅"
      });
    } catch (err) {
      console.error("❌ Error sending startup alert:", err.message);
    }
  }