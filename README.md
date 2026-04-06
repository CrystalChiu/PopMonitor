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

## Previews

Below are examples of PopMonitor in action during live monitoring.

### Restock Alerts
Real-time notifications when previously unavailable items return to stock.

<img
  src="https://github.com/user-attachments/assets/86c7cedc-131e-4b0b-8855-70d980f403ef"
  alt="Restock alert notification example"
  width="713"
/>

---

### Manual Fallback Warnings
During periods of heavy traffic, if PopMonitor cannot reliably reach the site, it alerts users that a restock is likely occurring rather than silently failing.

<img
  src="https://github.com/user-attachments/assets/57b199c9-27cf-4d09-aa87-387b29db2d49"
  alt="Manual fallback warning example"
  width="504"
/>

---

### Out-of-Stock Alerts
Notifications when monitored products sell out after being available.

<img
  src="https://github.com/user-attachments/assets/6d367bd8-628a-411b-9456-66b17ea9d752"
  alt="Out of stock alert example"
  width="577"
/>

---

### New Product Detection
Automatic detection of newly listed Labubu products.

<img
  src="https://github.com/user-attachments/assets/17e7f03b-f747-4d93-a8a4-4e232a7cc193"
  alt="New product detection example"
  width="456"
/>

---

In addition to availability changes, PopMonitor also detects price updates and other product changes!

## Project Status & Notes

PopMonitor was built to monitor real-time product availability during a period of extremely high demand for Labubu releases. The system successfully detected stock changes and notified users as intended during peak usage.

But, as demand increased, Popmart introduced additional anti-bot measures, including blocking major cloud IP ranges (such as its host EC2 instance) and later disabling headless browser access. While the monitor continued to function on residential hardware (Raspberry Pi), these constraints limited reliable deployment options without moving toward more aggressive or intrusive techniques. At that point, I chose to discontinue the project rather than escalate evasion methods.

Thank you to everyone who supported and followed the project. Feel free to contact me if you'd like to discuss the project or any potential future ideas!

-- Crystal
