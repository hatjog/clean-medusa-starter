import { Module } from "@medusajs/framework/utils"

import GpCoreService from "./service"

export const GP_CORE_MODULE = "gp_core"

export default Module(GP_CORE_MODULE, {
  service: GpCoreService,
})