const puppeteer = require('puppeteer');
const Product = require("./database/models/Products");

// ENUM for changes that create an alert
const ChangeTypeAlert = Object.freeze({
    RESTOCK: 0,
    NEW_ITEM: 1,
    OTHER: 2
  });
  
let TOTAL_PAGES = 1
let PAGE_WAIT_TIMEOUT = 60000
let alertProducts = []; // stores pairs of (product, changeTypes) that will become alerts
let changedProductsMap = {}

const buildBulkOps = (productsMap) => {
    return Object.values(productsMap).map((product) => ({
      updateOne: {
        filter: { name: product.name },
        update: {
          $set: {
            price: product.price,
            url: product.url,
            in_stock: product.in_stock,
            img_url: product.img_url ?? null, // include if available
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
  
async function checkProducts() {
    console.log("Running new scrape...");

    // restart scraper state
    alertProducts.length = 0;

    const browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();
    const allProducts = await Product.find(); // retrieve the current product stock state
    const allProductsMap = allProducts.reduce((acc, product) => {
        acc[product.name] = product;
        return acc;
    }, {});

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

        if (request.url().includes('/shop/v1/search') && request.method() === 'POST') {
          try {
            const postData = request.postData();
            if (postData && postData.includes('"term":"LABUBU"')) {
              console.log('Found LABUBU search request:', request.url());
            }
          } catch (e) {
            console.log("Something went wrong during page request: ", e);
          }
        }
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
                console.log("<DEBUG> Current page:", json.data.page);
          
                json.data.list.forEach((item, index) => {
                    let name = item.title;
                    let product = allProductsMap[name];
                    let inStock = item.isAvailable;
                    // let subTitle = item.subTitle; // (LABUBU, SKULLPANDA) use for scaling up to include more lines

                    let rawPrice = item.skus[0].price;
                    // let formattedPrice = formatPrice(rawPrice);

                    let productId = item.id;
                    let productSlug = slugifyTitle(name);
                    let productUrl = `https://www.popmart.com/us/products/${productId}/${productSlug}`;

                    // func to update product fields and track changes
                    const updateField = (field, newValue) => {
                        if (product[field] !== newValue) {
                            product[field] = newValue;
                            changedProductsMap[product.name] = product;
                        }
                    };

                    // keep track of database changes that need to be made based on scraped data
                    try {
                        if (!product) {
                            // new item identified
                            let newProduct = new Product({
                                name,
                                price: rawPrice,
                                in_stock: inStock,
                                url: productUrl,
                            });
                        
                            alertProducts.push([newProduct, ChangeTypeAlert.NEW_ITEM])
                            changedProductsMap[name] = newProduct;
                            console.log("Added new product:", name);
                        } else {
                            // restock detected
                            if (inStock && !product.in_stock) {
                                alertProducts.push([product, ChangeTypeAlert.RESTOCK]);
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

    let currentPage = 1;
    while(currentPage <= TOTAL_PAGES) {
        const searchUrl = `https://www.popmart.com/us/search/LABUBU?page=${currentPage}`;
        await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: PAGE_WAIT_TIMEOUT });
        currentPage++;
    }

    browser.close();

    console.log("No. DB Updates Needed: ", changedProductsMap.length);
    if (Object.keys(changedProductsMap).length > 0) {
        console.log("HERE");
        const bulkOps = buildBulkOps(changedProductsMap);
        const result = await Product.bulkWrite(bulkOps);
        console.log("Bulk write result:", result);
    }
    
    return alertProducts;
} 

module.exports = { checkProducts };