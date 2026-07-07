/**
 * Get seller ID from environment or fallback to user ID
 * SELLER_ID in .env is the Binance P2P merchant ID
 * This should be used for all seller-related queries
 */
function getSellerIdFromRequest(req) {
  // Priority: .env SELLER_ID > req.user.id
  const sellerId = process.env.SELLER_ID || (req?.user?.id);
  return sellerId;
}

module.exports = {
  getSellerIdFromRequest
};
