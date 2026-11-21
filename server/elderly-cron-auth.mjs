import { createRemoteJWKSet, errors, jwtVerify } from "jose";

const issuer = "https://token.actions.githubusercontent.com";
const audience = "https://sbm-ecru.vercel.app/api/cron/elderly-alerts";
const repository = "tanishq-mehta/sbm";
const branch = "refs/heads/main";
const keys = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks`));

export async function isAuthorizedElderlyCron(authorization) {
  const match = /^Bearer (\S+)$/.exec(authorization || "");
  if (!match) return false;

  try {
    const { payload } = await jwtVerify(match[1], keys, {
      issuer,
      audience,
      algorithms: ["RS256"],
      requiredClaims: ["exp", "iat", "nbf", "sub"],
      maxTokenAge: "10m",
      clockTolerance: 5,
    });
    return payload.repository_id === "1299715935"
      && payload.repository === repository
      && payload.ref === branch
      && payload.workflow_ref === `${repository}/.github/workflows/elderly-alerts.yml@${branch}`
      && ["schedule", "workflow_dispatch"].includes(payload.event_name);
  } catch (error) {
    if (error instanceof errors.JOSEError) return false;
    throw error;
  }
}
