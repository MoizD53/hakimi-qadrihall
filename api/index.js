// Vercel Serverless Function entry point
const path = require('path');
const app = require('../backend/server');

// Explicitly register static asset filepaths so @vercel/nft traces and bundles them into Lambda container
const NFT_TRACED_ASSETS = [
  path.join(__dirname, '../assets/evan-e-hakimi-main.jpg'),
  path.join(__dirname, '../assets/hakimi-construction-logo.jpg'),
  path.join(__dirname, '../assets/venue_stage.png'),
  path.join(__dirname, '../assets/venue_hall.png'),
  path.join(__dirname, '../assets/venue_arch.png'),
  path.join(__dirname, '../assets/venue_entrance.png'),
  path.join(__dirname, '../assets/venue_washarea.png'),
  path.join(__dirname, '../assets/paymentQR_v2.png'),
  path.join(__dirname, '../assets/favicon.svg'),
  path.join(__dirname, '../js/config.js'),
  path.join(__dirname, '../robots.txt'),
  path.join(__dirname, '../sitemap.xml'),
  path.join(__dirname, '../404.html'),
  path.join(__dirname, '../admin.html'),
  path.join(__dirname, '../pay.html'),
  path.join(__dirname, '../index.html')
];

module.exports = app;
