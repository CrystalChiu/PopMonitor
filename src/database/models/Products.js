const mongoose = require("mongoose");

// if we want this information we'd have to crawl each product to get it. that might be too disruptive...
// char_id: { type: mongoose.Schema.Types.ObjectId, ref: "Character" },
// img_url: { type: String, required: false },
const productSchema = new mongoose.Schema({
    product_id: { type: Number, required: true, unique: true },
    name: { type: String, required: true, unique: false },
    price: { type: Number, required: true },
    in_stock: { type: Boolean, required: true },
    url: { type: String, required: true },
    is_priority: { type: Boolean, required: true, default: false} // i will update this manually in db for now
  }, { timestamps: true });

const Product = mongoose.model("Product", productSchema);

module.exports = Product;
