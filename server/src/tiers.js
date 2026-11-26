const TIERS = {
  '1d':      { label: '1 Day',    ms: 24 * 60 * 60 * 1000 },
  '7d':      { label: '1 Week',   ms: 7 * 24 * 60 * 60 * 1000 },
  '30d':     { label: '1 Month',  ms: 30 * 24 * 60 * 60 * 1000 },
  'lifetime':{ label: 'Lifetime', ms: null }
};

function rank(tier) {
  return ['1d', '7d', '30d', 'lifetime'].indexOf(tier);
}

module.exports = { TIERS, rank };