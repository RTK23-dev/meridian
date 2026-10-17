-- 0102: Content Factory text files. A plain text file of at most 4000 characters is read into the session's brief: its text is kept on
-- its file row (content) and the request sends it as a brief source, labelled with the file name. The file's bytes still go to the
-- storage layer like every other file, so the row keeps its storage key, media type and SHA-256. Only a material file has content, and
-- only a text file has it: the reference video is never read into the brief, and images and PDFs keep no text here.

alter table content_factory_attachments add column if not exists content text;

alter table content_factory_attachments drop constraint if exists content_factory_attachments_content_check;
alter table content_factory_attachments add constraint content_factory_attachments_content_check check (
  content is null or (kind = 'file' and purpose = 'material' and char_length(content) between 1 and 4000)
);
