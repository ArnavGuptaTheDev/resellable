-- Image route looks up photos by R2 key to check who may see them.
-- Keys are shared between items when an item is duplicated, so not UNIQUE.
CREATE INDEX item_photos_r2_key ON item_photos(r2_key);
CREATE INDEX item_photos_thumb_key ON item_photos(thumb_key);
