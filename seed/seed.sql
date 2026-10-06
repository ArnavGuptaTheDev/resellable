-- Local development seed. Example data only; all addresses are @example.com.
--   npm run db:seed
-- Safe to re-run: fixed ids with INSERT OR IGNORE.
-- Sign in locally as these with /auth/dev-login?email=seller@example.com (or buyer@).

INSERT OR IGNORE INTO allowlist (email, role, invited_by, created_at) VALUES
  ('seller@example.com', 'seller', NULL, CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('buyer@example.com',  'buyer',  NULL, CAST(strftime('%s', 'now') AS INTEGER) * 1000);

INSERT OR IGNORE INTO users (id, email, name, created_at, payment_note) VALUES
  (1001, 'seller@example.com', 'Sample Seller', CAST(strftime('%s', 'now') AS INTEGER) * 1000, 'UPI: seller@upi (example)'),
  (1002, 'buyer@example.com',  'Sample Buyer',  CAST(strftime('%s', 'now') AS INTEGER) * 1000, NULL);

-- price is in paise (₹350 = 35000). NULL price = make an offer.
INSERT OR IGNORE INTO items (id, seller_id, title, description, category, tags, condition, quantity, price, status, created_at, updated_at) VALUES
  (2001, 1001, 'ESP32-WROOM-32 dev board', 'Dual-core, Wi-Fi + Bluetooth. USB-C, CP2102. Tested.', 'Microcontrollers', 'esp32,wifi,bluetooth', 'new', 24, 35000, 'listed', 1, 1),
  (2002, 1001, 'ESP8266 NodeMCU v3', 'CH340 USB. Headers soldered.', 'Microcontrollers', 'esp8266,wifi', 'used', 12, 18000, 'listed', 2, 2),
  (2003, 1001, 'Arduino Nano (clone)', 'ATmega328P, mini-USB.', 'Microcontrollers', 'arduino,atmega328p', 'new', 8, 22000, 'listed', 3, 3),
  (2004, 1001, 'DHT22 temperature & humidity sensor', NULL, 'Sensors', 'dht22,temperature,humidity', 'new', 30, 15000, 'listed', 4, 4),
  (2005, 1001, 'HC-SR04 ultrasonic distance sensor', NULL, 'Sensors', 'hc-sr04,ultrasonic,distance', 'new', 40, 6000, 'listed', 5, 5),
  (2006, 1001, 'L298N dual motor driver', 'Drives two DC motors or one stepper.', 'Motor drivers', 'l298n,motor', 'new', 10, 12000, 'listed', 6, 6),
  (2007, 1001, 'TT gear motor + wheel (pair)', 'Yellow 3–6 V gear motors with 65 mm wheels.', 'Motors', 'motor,wheel,robot', 'new', 16, 16000, 'listed', 7, 7),
  (2008, 1001, '2WD robot chassis kit', 'Acrylic base, caster wheel, battery holder.', 'Robotics', 'chassis,robot', 'new', 5, 30000, 'listed', 8, 8),
  (2009, 1001, 'Raspberry Pi 3B (no case)', 'Works fine; small scratch on the USB ports.', 'Single-board computers', 'raspberry pi,sbc', 'used', 1, NULL, 'listed', 9, 9),
  (2010, 1001, 'Assorted jumper wires (bag)', NULL, 'Accessories', 'jumper,wires', 'new', 50, 5000, 'listed', 10, 10),
  (2011, 1001, 'Broken OLED 0.96" displays', 'Lines across screen. For parts.', 'Displays', 'oled,ssd1306', 'for_parts', 6, NULL, 'listed', 11, 11),
  (2012, 1001, '', NULL, NULL, '', 'new', 1, NULL, 'draft', 12, 12);

-- Quantity tiers: 1 for ₹350, 5+ for ₹300 each, 10+ for ₹280.
INSERT OR IGNORE INTO item_price_tiers (item_id, min_qty, unit_price) VALUES
  (2001, 5, 30000),
  (2001, 10, 28000),
  (2005, 10, 5000),
  (2010, 3, 4000);

INSERT OR IGNORE INTO bundles (id, seller_id, title, description, pricing_mode, fixed_price, percent_off, status, created_at, updated_at) VALUES
  (3001, 1001, 'Build a Robot', 'Everything for a 2WD obstacle-avoiding robot except batteries.', 'percent_off', NULL, 15, 'listed', 1, 1);

INSERT OR IGNORE INTO bundle_items (bundle_id, item_id, quantity) VALUES
  (3001, 2003, 1),
  (3001, 2005, 1),
  (3001, 2006, 1),
  (3001, 2007, 1),
  (3001, 2008, 1),
  (3001, 2010, 1);

-- Readable timestamps (the literal 1..12 above keep a stable order).
UPDATE items SET created_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000 - (100 - id % 100) * 60000,
                 updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000 - (100 - id % 100) * 60000
 WHERE id BETWEEN 2001 AND 2012 AND created_at < 100;
UPDATE bundles SET created_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000,
                   updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
 WHERE id = 3001 AND created_at < 100;
