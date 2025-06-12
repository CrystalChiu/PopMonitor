# PopMonitor/Pop Mart Restock Tracker (v2)
Deprecated Tracker: https://github.com/CrystalChiu/PopmartRestockBot

This is a lightweight and performant web scraper designed to track product restocks and updates on [Pop Mart's US site](https://www.popmart.com/us). This version is a complete overhaul of the original tracker, built with improved performance, better reliability, and streamlined code structure. It also supports real-time alerts via Discord.

👍 This bot is in compliance with robots.txt

## Features

- Intercepts popmart network GET requests to efficiently retrieve product data
  - Uses the search API during low-traffic periods
  - Targets specific product pages during high-traffic/hot periods
- Throttles crawl frequency and limits checks to marked hot products during likely restock windows to reduce load and improve speed
- Detects and alerts of high network traffic to notify users of potential restocks if website is unresponsive
- Detects new products, price changes, and restocked inventory
- Writes bulk updates to MongoDB when changes are detected
- Sends Discord alerts for new or changed products
- Uses Puppeteer for fast and headless page navigation
- Built with Node.js
- We have bypassed the need for Chromium or Pupeteer Stealth in this version!

## Additional Comments:
- The discord link will be publically available soon!
- Anticipating expanding to Skullpanda next
- Thank you for your support and interest in this project, PopMart Friends <3
- Resellers stay away.
