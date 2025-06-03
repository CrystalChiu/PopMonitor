const { Client, GatewayIntentBits } = require("discord.js");
const { connectDB } = require("./database/database");
const { checkProducts } = require("./scraper");
const { CHECK_INTERVAL, PROD_CHANNEL_ID, TEST_CHANNEL_ID } = require("./config");
require("dotenv").config();

const MAX_JITTER_MS = 10 * 1000;
let mode = "prod"

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
    console.log(`*** App running in ${mode} ***`);
  
    let CHANNEL_ID = mode == "test" ? TEST_CHANNEL_ID : PROD_CHANNEL_ID;
  
    // Start the infinite loop
    monitor(CHANNEL_ID);
  });
  
async function monitor(CHANNEL_ID) {
    while(true) {
        const alertProducts = await checkProducts();

        for (const [product, changeType] of alertProducts) {
            await sendAlert(product, changeType, CHANNEL_ID);
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

async function sendAlert(product, changeType, CHANNEL_ID) {
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