const puppeteer = require('puppeteer');
const Product = require("./database/models/Products");
const PageError = require('./errors/PageError');

// ENUM for changes that create an alert
const ChangeTypeAlert = Object.freeze({
    RESTOCK: 0,
    NEW_ITEM: 1,
    OTHER: 2
  });
  
let TOTAL_PAGES = 1;
let allProductsMap = {};
let alertProducts = []; // stores pairs of (product, changeTypes) that will become alerts
let changedProductsMap = {};
let pageFails = 0;
let firstPageRetries = 0;
let cache = false;

const buildBulkOps = (productsMap) => {
    return Object.values(productsMap).map((product) => ({
      updateOne: {
        filter: { productId: product.productId },
        update: {
          $set: {
            name: product.name,
            price: product.price,
            url: product.url,
            in_stock: product.in_stock,
          },
        },
        upsert: true,
      },
    }));
};
  

function slugifyTitle(title) {
    return title
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')   // remove non-alphanumeric except space and dash
      .trim()
      .replace(/\s+/g, '-');          // replace spaces with dashes
  }

function scraperInit() {
    console.log("New scrape session started — " + new Date().toLocaleString());

    // restart scraper state
    alertProducts.length = 0;
    pageFails = 0;
    firstPageRetries = 0;
    changedProductsMap = {};
}

async function checkHotProducts() {
    let PAGE_WAIT_TIMEOUT = 100000;
    scraperInit();
  
    const browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();
  
    const priorityProducts = await Products.find({ is_priority: true });
  
    for (const product of priorityProducts) {
      let url = product.url;
      console.log("Visiting:", url);
  
      try {
        await page.goto(url, { waitUntil: 'networkidle2', timeout: PAGE_WAIT_TIMEOUT });
  
        const data = await page.evaluate(() => {
          try {
            return window.__INITIAL_STATE__.product.productDetailInfo;
          } catch (e) {
            return null;
          }
        });
  
        if (!data || !data.skus || !data.skus[0]) {
          console.warn(`⚠️ Couldn't extract data for: ${product.name}`);
          continue;
        }
  
        const wasInStock = product.in_stock;
        const isInStock = data.skus[0].stock.onlineStock > 0;
        const productImgUrl = data.skus[0].mainImage;
  
        if (wasInStock === false && isInStock === true) {
          alertProducts.push([product, ChangeTypeAlert.RESTOCK, productImgUrl]);
          console.log(`🔔 Restock detected: ${product.name}`);
        }
  
        // in this case we will update DB immediately
        if (wasInStock !== isInStock) {
          product.in_stock = isInStock;
          await product.save();
        }
  
      } catch (e) {
        console.error(`❌ Error visiting ${url}: ${e.message}`);
      }
    }
  
    await browser.close();
    return alertProducts;
}
  
async function checkProducts() {
    scraperInit();

    const browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();

    // TODO: add cache logic
    if(!cache) {
        const allProducts = await Product.find(); // retrieve the current product stock state
        console.log(`Found ${allProducts.length} existing products in the database`);
        allProductsMap = allProducts.reduce((acc, product) => {
            acc[product.productId] = product;
            return acc;
        }, {});
    }

    await page.setRequestInterception(true);

    page.on('request', async (request) => {
        const blocked = ['google-analytics.com',
                        'quickcep.com', 
                        'intercom.io', 
                        'track/v1/track/track-events'
                        ];
        if (blocked.some(domain => request.url().includes(domain))) {
            return request.abort();
        }
        request.continue();
    });

    page.on('response', async (response) => {
        const url = response.url();
        const contentType = response.headers()['content-type'] || '';
      
        if (!contentType.includes('application/json')) return;
      
        try {
            const json = await response.json();
    
            if (
                json?.code === 'OK' &&
                json?.data?.total &&
                Array.isArray(json?.data?.list)
              ) {
                TOTAL_PAGES = Math.ceil(json.data.total / json.data.pageSize);
          
                json.data.list.forEach((item, index) => {
                    let name = item.title;
                    let rawPrice = item.skus[0].price;
                    let imgUrl = item.bannerImages[0];
                    let productId = item.id;
                    let product = allProductsMap[productId];
                    let inStock = item.skus[0].stock.onlineStock == 0 ? false : true;
                    // let subTitle = item.subTitle; // (LABUBU, SKULLPANDA) use for scaling up to include more lines

                    let productSlug = slugifyTitle(name);
                    let productUrl = `https://www.popmart.com/us/products/${productId}/${productSlug}`;

                    // func to update product fields and track changes
                    const updateField = (field, newValue) => {
                        if (product[field] !== newValue) {
                            console.log(`Updated ${field} for ${name} from ${product[field]} to ${newValue}`);
                            product[field] = newValue;
                            changedProductsMap[product.productId] = product;
                        }
                    };

                    // keep track of database changes that need to be made based on scraped data
                    try {
                        if (!product) {
                            // new item identified
                            let newProduct = new Product({
                                productId,
                                name,
                                price: rawPrice,
                                in_stock: inStock,
                                url: productUrl,
                            });
                        
                            alertProducts.push([newProduct, ChangeTypeAlert.NEW_ITEM, imgUrl])
                            changedProductsMap[productId] = newProduct;
                            console.log("Added new product:", name);
                        } else {
                            // restock detected
                            if (inStock && !product.in_stock) {
                                alertProducts.push([product, ChangeTypeAlert.RESTOCK, imgUrl]);
                                updateField("in_stock", inStock);
                                console.log("Restock detected: ", name);
                            }
                        
                            // handle other product detail changes
                            updateField("price", rawPrice);
                            updateField("url", productUrl);
                        }
                    } catch (err) {
                        console.error(`❌ Error processing ${name}: ${err.message}`);
                    }
                });
              }
        } catch (e) {
            console.error(`Failed to parse JSON from ${url}: ${e.message}`);
        }
    });

    let PAGE_WAIT_TIMEOUT = 100000;
    let PAGE_RETRY_DELAY = 30000;
    let MAX_PAGE_FAILS = 3;
    let currentPage = 1;
    console.log("Scraping product listings:");
    while(currentPage <= TOTAL_PAGES) {
        const searchUrl = `https://www.popmart.com/us/search/LABUBU?page=${currentPage}`;
        console.log(`→ Scraping page ${currentPage}...`);

        try {
            await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: PAGE_WAIT_TIMEOUT });
            pageFails = 0; // reset fail count on success
        } catch (e) {
            pageFails++;
            console.error(`❌ Error on page ${currentPage}: ${e.message}`);

            if (currentPage === 1) {
                firstPageRetries++;
                if (firstPageRetries >= MAX_PAGE_FAILS) {
                    throw new PageError(`Failed to connect to the website after ${firstPageRetries} attempts. Aborting.`);
                }
    
                console.log(`🔁 Retrying page 1 in ${PAGE_RETRY_DELAY}ms (attempt ${firstPageRetries}/${MAX_PAGE_FAILS})...`);
                await new Promise(resolve => setTimeout(resolve, PAGE_RETRY_DELAY));
                continue; // retry page 1
            } else {
                if (pageFails >= MAX_PAGE_FAILS) {
                    console.log(`⚠️ Skipping page ${currentPage} after ${pageFails} failures.`);
                    pageFails = 0;
                } else {
                    console.log(`🔁 Retrying page ${currentPage} (attempt ${pageFails}/${MAX_PAGE_FAILS})...`);
                    continue; // retry same page
                }
            }
        }
        currentPage++;
    }

    browser.close();

    console.log("No. DB Updates Needed: ", Object.keys(changedProductsMap).length);
    if (Object.keys(changedProductsMap).length > 0) {
        const bulkOps = buildBulkOps(changedProductsMap);
        const result = await Product.bulkWrite(bulkOps);
        console.log("Bulk write result:", result);
        
        cache = false; // changes made, cache outdated
    } else {
        cache = true; // no changes made, keep cache
    }
    
    return alertProducts;
} 

module.exports = { checkProducts, checkHotProducts };