export const SOURCE_ADAPTERS = [
  {
    id: "manual_observation",
    label: "Manual observation",
    implemented: true,
    note: "Record a creative you have actually seen. Nothing is invented to fill the list.",
  },
  {
    id: "public_page",
    label: "Public page",
    implemented: true,
    note: "Reads one public page you name and stores the text as untrusted data. It is not written into the brand brain.",
  },
  {
    id: "ad_library",
    label: "Meta Ad Library",
    implemented: true,
    note: "Bounded, job-backed video-ad collection. Requires META_AD_LIBRARY_TOKEN; records without a public downloadable video stay unavailable and are not analyzed.",
  },
] as const;
