-- 0155: reference images and longer text files in the Content Factory (the Create page).
--
-- A picture a person marks as a reference is kept as a reference image: it goes to the engine as a brief attachment named as one (its
-- pixels are not read), next to the one reference video a session may have. Like a material image, its row keeps its measured size in
-- content.
--
-- A text file (or a PDF's text) of up to 8000 characters, the engine's whole brief, is now read into the brief, in parts of at most
-- 4000 (one brief source each). A longer text file is kept with its session and marked as over the limit, never cut.

alter table content_factory_attachments drop constraint if exists content_factory_attachments_purpose_check;
alter table content_factory_attachments add constraint content_factory_attachments_purpose_check check (
  purpose is null or purpose in ('reference_video', 'reference_image', 'material')
);

alter table content_factory_attachments drop constraint if exists content_factory_attachments_content_check;
alter table content_factory_attachments add constraint content_factory_attachments_content_check check (
  content is null or (kind = 'file' and purpose in ('material', 'reference_image') and char_length(content) between 1 and 8000)
);
