/**
 * Auth0 Post Login Action.
 * Create an Action in Auth0 Dashboard > Actions > Library, paste this script,
 * and attach it to the Login flow. This makes email verification explicit in
 * the custom API access token without trusting user-editable app metadata.
 */
exports.onExecutePostLogin = async (event, api) => {
  const namespace = "https://physiotrace.app/";
  if (event.user.email) {
    api.accessToken.setCustomClaim(`${namespace}email`, event.user.email);
  }
  api.accessToken.setCustomClaim(
    `${namespace}email_verified`,
    Boolean(event.user.email_verified)
  );
  if (event.user.name) {
    api.accessToken.setCustomClaim(`${namespace}name`, event.user.name);
  }
};
