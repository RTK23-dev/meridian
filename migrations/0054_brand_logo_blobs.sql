-- Brand logos were written to assets.body only. The asset route serves bytes from asset_blobs, so a logo could not be shown
-- by id. This copies each stored logo whose bytes are not yet in asset_blobs, under the storage key its asset row names. The
-- checksum and length are the ones the route checks. Rows that are already there are left alone, so this can run again.
insert into asset_blobs (storage_key, organization_id, brand_id, body, mime_type, checksum, byte_size, version, lifecycle)
select a.storage_key, a.organization_id, a.brand_id, a.body, a.mime_type,
       encode(sha256(decode(a.body, 'base64')), 'hex'), length(decode(a.body, 'base64')), 1, 'stored'
from assets a
where a.label = 'logo' and a.status = 'stored' and a.body <> ''
  and a.body ~ '^[A-Za-z0-9+/]+={0,2}$' and length(a.body) % 4 = 0
on conflict (storage_key) do nothing;
