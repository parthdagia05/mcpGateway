#!/bin/sh
# First-time store setup, run by the setup Job after every "helm install" and "helm upgrade".
#
# Every step CHECKS FIRST and only does work if it's missing, so running this twice is harmless.
# That matters because Helm reruns it on each upgrade, and Kubernetes retries it if it fails halfway.
#
# It shares the WordPress files disk and reads wp-config.php, so "wp" commands act on the real store.
set -eu
cd /var/www/html
log() { echo "[setup] $*"; }

# --- 1. Wait for WordPress and the database --------------------------------------------------------
# The WordPress Pod copies its files onto the shared disk on first start; until then there's nothing to configure.
log "waiting for WordPress files..."
until [ -f wp-config.php ]; do sleep 5; done

log "waiting for the database..."
until wp db query "SELECT 1" >/dev/null 2>&1; do sleep 5; done

# --- 2. Install WordPress (replaces the browser install wizard) --------------------------------------
if wp core is-installed; then
  log "WordPress already installed"
else
  log "installing WordPress"
  wp core install \
    --url="$SITE_URL" \
    --title="$SITE_TITLE" \
    --admin_user="$ADMIN_USER" \
    --admin_password="$ADMIN_PASSWORD" \
    --admin_email="$ADMIN_EMAIL" \
    --skip-email
fi

# Keep the site URL in line with Helm values (e.g. a new domain on the VPS). Setting it again is harmless.
wp option update home "$SITE_URL" >/dev/null
wp option update siteurl "$SITE_URL" >/dev/null

# Pretty permalinks (/shop/, /product/x/). With "plain" permalinks the /wp-json REST API URLs don't work,
# and our MCP server needs the REST API.
wp rewrite structure '/%postname%/' >/dev/null

# --- 3. WooCommerce ------------------------------------------------------------------------------------
if wp plugin is-installed woocommerce; then
  log "WooCommerce already installed"
else
  log "installing WooCommerce $WOO_VERSION"
  wp plugin install woocommerce --version="$WOO_VERSION"
fi
wp plugin is-active woocommerce || wp plugin activate woocommerce

# Store settings. "option update" just overwrites, so these are always safe to rerun.
wp option update timezone_string "$TIMEZONE" >/dev/null          # order times shown in the same timezone woo-mcp uses
wp option update woocommerce_currency "$CURRENCY" >/dev/null
wp option update woocommerce_default_country "IN:DL" >/dev/null
wp option update woocommerce_coming_soon "no" >/dev/null          # new stores start hidden in "coming soon" mode
wp option update woocommerce_ship_to_countries "disabled" >/dev/null  # no shipping step: checkout needs no address zones
wp option update woocommerce_calc_taxes "no" >/dev/null
wp option update woocommerce_enable_guest_checkout "yes" >/dev/null
wp option update woocommerce_onboarding_profile '{"skipped":true}' --format=json >/dev/null

# Cash on delivery: the test-friendly payment method for the demo checkout.
wp option update woocommerce_cod_settings \
  '{"enabled":"yes","title":"Cash on delivery","description":"Pay with cash upon delivery.","instructions":"Pay with cash upon delivery.","enable_for_methods":[],"enable_for_virtual":"yes"}' \
  --format=json >/dev/null

# Shop, Cart, Checkout and My Account pages (skips any that already exist).
wp wc tool run install_pages --user="$ADMIN_USER" >/dev/null

# --- 4. REST API key for the WooCommerce MCP server -----------------------------------------------------
# Helm generated the key + secret (Secret "urumi-woo-api"); here we register them inside WooCommerce.
# WooCommerce has no wp-cli command for API keys, so we write the row the same way its admin screen does:
# the consumer key is stored HASHED (wc_api_hash), the secret as-is, plus the last 7 chars for display.
# If a key with this hash exists we do nothing; if the Secret was rotated, the old "woo-mcp" key is replaced.
wp eval '
  global $wpdb;
  $table = $wpdb->prefix . "woocommerce_api_keys";
  $ck    = getenv("WOO_CONSUMER_KEY");
  $cs    = getenv("WOO_CONSUMER_SECRET");
  $hash  = wc_api_hash($ck);
  if ($wpdb->get_var($wpdb->prepare("SELECT key_id FROM $table WHERE consumer_key = %s", $hash))) {
    echo "[setup] REST API key for woo-mcp already registered\n";
    return;
  }
  $wpdb->delete($table, ["description" => "woo-mcp"]);
  $admin = get_user_by("login", getenv("ADMIN_USER"));
  $wpdb->insert($table, [
    "user_id"         => $admin->ID,
    "description"     => "woo-mcp",
    "permissions"     => "read_write",
    "consumer_key"    => $hash,
    "consumer_secret" => $cs,
    "truncated_key"   => substr($ck, -7),
  ]);
  echo "[setup] registered REST API key for woo-mcp\n";
'

# --- 5. One sample product, so a fresh store isn't empty ------------------------------------------------
if [ "$(wp post list --post_type=product --format=count)" = "0" ]; then
  log "creating a sample product"
  wp wc product create --name="Urumi T-Shirt" --regular_price=499 --user="$ADMIN_USER" >/dev/null
fi

log "done: store is ready at $SITE_URL"
