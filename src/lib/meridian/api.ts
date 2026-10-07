/**
 * Meridian API: entrypoint delegating to domain-specific modules.
 * Domains:
 * - workspace: workspace & organization settings, members, invitations
 * - brand: brand identity, brain configuration, brain versions
 * - products: product catalog management
 */

export {
  bootstrap,
  createOrganization,
  setActiveOrganization,
  renameOrganization,
  updateWeights,
  addMember,
  acceptInvite,
  changeMemberRole,
  type OrgSummary,
  type BrandSummary,
  type AuditEntry,
  type MemberRow,
  type InviteRow,
  type Bootstrap,
} from "./workspace/actions";

export {
  createBrand,
  updateBrand,
  deleteBrand,
  getBrand,
  saveBrain,
  AUTOMATION_CHOICES,
  type BrandIdentity,
  type BrainVersion,
  type BrandDetail,
  type AutomationLevel,
  type BrainKey,
} from "./brand/actions";

export {
  saveProduct,
  deleteProduct,
  type ProductRow,
} from "./products/actions";
