'use strict';

const crypto = require('node:crypto');

const LIVE = process.env.ESEWA_ENV === 'live';
const FORM_URL = process.env.ESEWA_FORM_URL || (LIVE
  ? 'https://epay.esewa.com.np/api/epay/main/v2/form'
  : 'https://rc-epay.esewa.com.np/api/epay/main/v2/form');
const STATUS_URL = process.env.ESEWA_STATUS_URL || (LIVE
  ? 'https://epay.esewa.com.np/api/epay/transaction/status/'
  : 'https://rc.esewa.com.np/api/epay/transaction/status/');

function config() {
  const productCode = process.env.ESEWA_PRODUCT_CODE;
  const secret = process.env.ESEWA_SECRET_KEY;
  if (!productCode || !secret) throw new Error('ESEWA_PRODUCT_CODE / ESEWA_SECRET_KEY are not set');
  return { productCode, secret };
}


