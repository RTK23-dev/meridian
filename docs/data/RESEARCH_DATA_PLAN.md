# Keeping research data, for the researcher agents

Status: a proposal for the owner's decision. Nothing here is built yet. The storage choices in section 4 need approval before any code.

## 1. The goal

Meridian should keep as much of its own data as it can, in a form that is cheap to store and easy to read, so that research agents can
find the content strategies with the best return on investment, from the starting point (A) to the outcome (B). The data is only useful
if it is complete. A decision or a result that is not kept cannot be studied later.

## 2. What to keep

Keep every record that explains a result. In order of value:

1. **Decisions.** Each choice the system made, with the options it weighed, the score of each, the reason, and the version of the rules
   it used. (The decision record already exists in the database, and the research needs its full history.)
2. **Results.** Each creative's measured performance over time: views, watch time, saves, shares, and cost. Each figure keeps the date it was read.
3. **Costs.** Each provider call: its estimate, what was reserved, and what was billed. A cost with no bill stays unknown, never zero.
4. **Prices.** Each price the system used, with its source and the date it was read. These are already saved in `docs/data/prices/`
   (see the README there).
5. **Inputs.** The brief, the reference video's analysis, the script, the plan, and the settings each run started with.
6. **Creatives.** The output's identity (a content hash), its size and its duration. The file itself stays in storage, and the record points to it.

## 3. How to keep it efficiently

- **Append only.** A record is added, never changed in place. A correction is a new record that points to the old one. This keeps the
  history that research needs.
- **One row per event, in batches.** Store each day's records as one compressed file, rather than one file per record.
- **Columnar format for analysis.** Parquet compresses well and reads fast for research. It needs a new library, which needs approval.
  Until then, the batches are gzip-compressed JSON Lines, which need no new dependency.
- **Content by hash.** Files are stored once under their hash, so the same video is never kept twice.
- **Keep the summary in the database.** The database holds the index (what exists, when, and where it is in storage). The bulk data sits in
  object storage.
- **No duplicate fields.** A value is stored once, with its id, and referenced everywhere else.

## 4. Decisions needed from the owner

1. **Where the bulk data lives.** The project's storage interface already exists (no vendor SDK is added). Choose the bucket or the folder
   for the batches, and say whether it is the same place as the uploaded files.
2. **Parquet or JSON Lines.** Parquet needs a new dependency (approval needed). JSON Lines needs none.
3. **Retention.** How long to keep the bulk data, and whether any of it is deleted on request (for example, a person's uploaded video).
4. **Personal data.** Viewer data from platforms may be personal. Say which fields may be kept, and which must be dropped or hashed.
5. **Who may read it.** Research agents only, or the owner's team as well.
6. **Schema changes.** Adding a table or a column is a change the owner must approve, because it touches the shared data formats.

## 5. The first step, once approved

Start with decisions and costs, the two that the current database already records, and export them in batches each night. Add results next,
then creatives and inputs. Each step is checked by a test that the batch reads back to the same records.
