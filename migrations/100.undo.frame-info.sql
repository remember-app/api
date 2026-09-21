DROP TABLE IF EXISTS montage_frames;
ALTER TABLE media_items DROP COLUMN IF EXISTS longitude;
ALTER TABLE media_items DROP COLUMN IF EXISTS latitude;
ALTER TABLE media_items DROP COLUMN IF EXISTS aperture;
ALTER TABLE media_items DROP COLUMN IF EXISTS focal_length_mm;
ALTER TABLE media_items DROP COLUMN IF EXISTS camera_model;
ALTER TABLE media_items DROP COLUMN IF EXISTS file_name;
