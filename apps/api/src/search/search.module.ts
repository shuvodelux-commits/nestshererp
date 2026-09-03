import { Module } from '@nestjs/common';
import type {
  AccessControl,
  PartyRepository,
  ProductRepository,
  PurchaseRepository,
  SaleRepository,
  SettingsRepository,
  UnitOfWork,
} from '@sher/core-application';
import { GlobalSearchService } from '@sher/core-application';

import {
  ACCESS_CONTROL,
  PARTY_REPOSITORY,
  PRODUCT_REPOSITORY,
  PURCHASE_REPOSITORY,
  SALE_REPOSITORY,
  SETTINGS_REPOSITORY,
  UNIT_OF_WORK,
} from '../infrastructure/tokens';
import { SearchController } from './search.controller';
import { GLOBAL_SEARCH_SERVICE } from './tokens';

/**
 * Phase 18.1. Six repositories and no writer: Global Search reads what the
 * Products, Parties, Sales and Purchases modules already own, and owns no table
 * of its own — which is why it is a module here rather than an endpoint bolted
 * onto one of the four.
 */
@Module({
  controllers: [SearchController],
  providers: [
    {
      provide: GLOBAL_SEARCH_SERVICE,
      useFactory: (
        uow: UnitOfWork,
        accessControl: AccessControl,
        products: ProductRepository,
        parties: PartyRepository,
        sales: SaleRepository,
        purchases: PurchaseRepository,
        settings: SettingsRepository,
      ): GlobalSearchService =>
        new GlobalSearchService(uow, accessControl, products, parties, sales, purchases, settings),
      inject: [
        UNIT_OF_WORK,
        ACCESS_CONTROL,
        PRODUCT_REPOSITORY,
        PARTY_REPOSITORY,
        SALE_REPOSITORY,
        PURCHASE_REPOSITORY,
        SETTINGS_REPOSITORY,
      ],
    },
  ],
})
export class SearchModule {}
