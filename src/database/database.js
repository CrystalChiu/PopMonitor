const mongoose = require("mongoose");

async function connectDB() {
    console.log("Connecting to database...");
    try {
        await mongoose.connect(process.env.MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true });
        console.log("✅ MongoDB Connected!");
    } catch(error) {
        console.error("❌ MongoDB Connection Error:", error);
        process.exit(1);
    }
}

module.exports = { connectDB };
