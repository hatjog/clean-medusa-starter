/**
 * v1.16.0 Story 11.3 (D-37): POST /admin/recovery/:population/:id/propose?market_id=<rynek>
 * — krok "propose" akcji recovery. Reguły domenowe: lib/recovery/recovery-action-runtime.ts.
 */
import { handleRecoveryStep } from "../../../../../../lib/recovery/recovery-action-http"
import { withOperatorAuth } from "../../../../../../middlewares/with-operator-auth"

export const POST = withOperatorAuth((req, res) => handleRecoveryStep("propose", req, res))
