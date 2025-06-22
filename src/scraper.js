const puppeteer = require('puppeteer');
const Product = require("./database/models/Products");
const PageError = require('./errors/PageError');
const HighTrafficError = require('./errors/HighTrafficError');
const { BASE_URL } = require("./config");

// ENUM for changes that create an alert
const ChangeTypeAlert = Object.freeze({
    RESTOCK: 0,
    NEW_ITEM: 1,
    OTHER: 2,
    SOLD_OUT: 3,
});

const FAIL_THRESHOLD = 0.5; // 50% failure rate
let allProductsMap = {};
let alertProducts = []; // stores pairs of (product, changeTypes) that will become alerts
let changedProductsMap = {};
let pageFails = 0;
let firstPageRetries = 0;
let cache = false;
let currentPage = 1;

const buildBulkOps = (productsMap) => {
    return Object.values(productsMap).map((product) => ({
      updateOne: {
        filter: { product_id: product.product_id },
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

async function updateDb() {
    console.log("No. DB Updates Needed: ", Object.keys(changedProductsMap).length);
    if (Object.keys(changedProductsMap).length > 0) {
        const bulkOps = buildBulkOps(changedProductsMap);
        const result = await Product.bulkWrite(bulkOps);
        console.log("Bulk write result:", result);
        
        cache = false; // changes made, cache outdated
    } else {
        cache = true; // no changes made, keep cache
    }
}

async function checkHotProducts() {
    let PAGE_WAIT_TIMEOUT = 100000;
    scraperInit();
  
    const browser = await puppeteer.launch({ 
        headless: false,
        args: [
            '--disable-gpu',
            '--disable-dev-shm-usage',
            '--disable-setuid-sandbox',
            '--no-sandbox',
            '--no-zygote',
            '--disable-accelerated-2d-canvas',
            '--disable-features=site-per-process',
            '--disable-infobars',
            '--window-size=1920,1080',
          ],
          defaultViewport: null,
    });
    const page = await browser.newPage();

    await page.setRequestInterception(true);

    // block unnecessary resources for speed
    page.on("request", (req) => {
        const resourceType = req.resourceType();
        if (["image", "stylesheet", "font", "media"].includes(resourceType)) {
        return req.abort();
        }
        req.continue();
    });

    let interceptedData = null;

    page.on("response", async (response) => {
        const url = response.url();
        const contentType = response.headers()["content-type"] || "";
    
        if (contentType.includes("application/json") && url.includes("productDetails")) {
          try {
            const json = await response.json();
            if (json?.code === "OK" && 
                json?.data?.skus && 
                url.includes('productDetails')
            ) {
                interceptedData = json.data;
            }
          } catch (e) {
            console.error(`Failed to parse productDetails JSON from ${url}: ${e.message}`);
          }
        }
    });
  
    const priorityProducts = await Product.find({ is_priority: true });
    let failedCount = 0;
    const total = priorityProducts.length;
  
    for (const product of priorityProducts) {
        interceptedData = null; // reset data for each product
        let url = product.url;
        console.log("Visiting:", url);
  
        try {
            await page.goto(url, { waitUntil: "networkidle2", timeout: PAGE_WAIT_TIMEOUT });
            
            const data = interceptedData;
    
            if (!data) {
                console.warn(`⚠️ Couldn't extract data for: ${product.name}`);
                failedCount++;
                continue;
            }

            const wasInStock = product.in_stock;
            const isInStock = data.skus[0].stock.onlineStock > 0;
            const productImgUrl = data.skus[0].mainImage;

            if (wasInStock === false && isInStock === true) {
                product.in_stock = isInStock;
                alertProducts.push([product, ChangeTypeAlert.RESTOCK, productImgUrl]);
                changedProductsMap[product.product_id] = product;
                console.log(`Restock detected: ${product.name}`);
            } else if(wasInStock === true && isInStock === false) {
                product.in_stock = isInStock;
                alertProducts.push([product, ChangeTypeAlert.SOLD_OUT, productImgUrl]);
                changedProductsMap[product.product_id] = product;
                console.log(`Item just sold out: ${product.name}`);
            }

            if (failedCount / total > FAIL_THRESHOLD) {
                throw new HighTrafficError("🚨 High traffic or site failure detected");
            }
        } catch (e) {
            if(e instanceof HighTrafficError) {
                throw e;
            }

            console.error(`❌ Error visiting ${url}: ${e.message}`);
            failedCount++;

            if (failedCount / total > FAIL_THRESHOLD) {
                throw new HighTrafficError("🚨 High traffic or site failure detected");
            }

            continue;
        }
    }
  
    await browser.close();
    await updateDb();

    return alertProducts;
}
  
async function checkProducts() {
    scraperInit();
    let totalPages = 1;

    const browser = await puppeteer.launch({ 
        headless: false,
        args: [
            '--disable-gpu',
            '--disable-dev-shm-usage',
            '--disable-setuid-sandbox',
            '--no-sandbox',
            '--no-zygote',
            '--disable-accelerated-2d-canvas',
            '--disable-features=site-per-process',
            '--disable-infobars',
            '--window-size=1920,1080',
          ],
          defaultViewport: null, 
    });
    const page = await browser.newPage();

    if(!cache) {
        const allProducts = await Product.find(); // retrieve the current product stock state
        console.log(`Found ${allProducts.length} existing products in the database`);
        allProductsMap = allProducts.reduce((acc, product) => {
            acc[product.product_id] = product;
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
        // filtering irrelevant requests
        const request = response.request();
        const url = response.url();
        const method = request.method(); // <----- NEW: get the request method
        const contentType = response.headers()["content-type"] || "";

        if (
            url.includes('/shop/v1/search') &&
            contentType.includes('application/json')
        ) {
            try {
                const json = await response.json();
        
                if (
                    json?.code === 'OK' &&
                    json?.data?.total &&
                    Array.isArray(json?.data?.list)
                ) {
                    totalPages = Math.ceil(json.data.total / json.data.pageSize);
              
                    json.data.list.forEach((item, index) => {
                        let name = item.title;
                        let rawPrice = item.skus[0].price;
                        let imgUrl = item.bannerImages[0];
                        let productId = item.id;
                        let product = allProductsMap[productId];
                        let inStock = item.skus[0].stock.onlineStock == 0 ? false : true;
                        let isPopNow = item.type === "secret" ? true : false;
                        // let subTitle = item.subTitle; // (LABUBU, SKULLPANDA) use for scaling up to include more lines
    
                        const productSlug = slugifyTitle(name);
                        const defaultProductUrl = `https://www.popmart.com/us/products/${productId}/${productSlug}`;
                        const searchUrl = `${BASE_URL}${currentPage}`;
                        // we cannot rebuild the url for popnow links, let the user find it quicker from search page
                        let productUrl = isPopNow === false ? defaultProductUrl : searchUrl;
    
                        // func to update product fields and track changes
                        const updateField = (field, newValue) => {
                            if (product[field] !== newValue) {
                                console.log(`Updated ${field} for ${name} from ${product[field]} to ${newValue}`);
                                product[field] = newValue;
                                changedProductsMap[product.product_id] = product;
    
                                if(field == "price" || field == "url") {
                                    alertProducts.push([product, ChangeTypeAlert.OTHER, imgUrl]);
                                }
                            }
                        };
    
                        // keep track of database changes that need to be made based on scraped data
                        try {
                            if (!product) {
                                // new item identified
                                let newProduct = new Product({
                                    product_id: productId,
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
        }
    });

    const PAGE_WAIT_TIMEOUT = 100000;
    const PAGE_RETRY_DELAY = 30000;
    const MAX_PAGE_FAILS = 3;
    console.log("Scraping product listings:");
    while(currentPage <= totalPages) {
        const searchUrl = `${BASE_URL}${currentPage}`;
        console.log(`→ Scraping page ${currentPage}...`);

        try {
            // FIXME: if the page loads but returns nothing (delayed) --> count that as possible high traffic
            await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: PAGE_WAIT_TIMEOUT });
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
    await updateDb();

    return alertProducts;
} 

module.exports = { ChangeTypeAlert, checkProducts, checkHotProducts };