import type { MedusaRequest } from "@medusajs/framework/http"
import {
  ContainerRegistrationKeys,
  generateJwtToken,
} from "@medusajs/framework/utils"

type ConfigModuleLike = {
  projectConfig?: {
    http?: {
      jwtSecret?: string
      jwtExpiresIn?: string
      jwtOptions?: Record<string, unknown>
    }
  }
}

function resolveConfig(req: MedusaRequest): ConfigModuleLike | null {
  try {
    return req.scope.resolve(ContainerRegistrationKeys.CONFIG_MODULE) as ConfigModuleLike
  } catch {
    return null
  }
}

export function issueRecoverCustomerSessionToken(
  req: MedusaRequest,
  customerId: string
): string | null {
  const http = resolveConfig(req)?.projectConfig?.http
  if (!http?.jwtSecret || !http.jwtExpiresIn) {
    return null
  }

  try {
    return generateJwtToken(
      {
        actor_id: customerId,
        actor_type: "customer",
        auth_identity_id: "",
        app_metadata: {
          customer_id: customerId,
        },
        user_metadata: {},
      },
      {
        secret: http.jwtSecret,
        expiresIn: http.jwtExpiresIn,
        jwtOptions: http.jwtOptions,
      }
    )
  } catch {
    return null
  }
}
