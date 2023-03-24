import { Amm } from "@jup-ag/core";
import { AccountInfoMap } from "@jup-ag/core/dist/lib/amm.js";
import { connection } from "../connection.js";
import { AccountSubscriptionHandlersMap } from "../geyser.js";
import { logger } from "../logger.js";

class GeyserJupiterUpdateHandler {
    amm: Amm;
    isInitialized: boolean;
    resolveOnInitialized: Promise<void>;
    accountInfoMap: AccountInfoMap;

    constructor(amm: Amm) {
        this.amm = amm;
        this.accountInfoMap = new Map();
        this.isInitialized = false;

        let resolve: () => void;
        this.resolveOnInitialized = new Promise((r) => { resolve = r; });

        const addresses = this.amm.getAccountsForUpdate();
        connection.getMultipleAccountsInfo(addresses).then((accountInfos) => {
            for (let i = 0; i < accountInfos.length; i++) {
                this.accountInfoMap.set(addresses[i].toBase58(), accountInfos[i]);
            }
            this.isInitialized = true;
            resolve();
            this.amm.update(this.accountInfoMap);
        });
    }

    getUpdateHandlers(): AccountSubscriptionHandlersMap {
        const geyserSubscriptions: AccountSubscriptionHandlersMap = new Map();

        for (const address of this.amm.getAccountsForUpdate()) {
            geyserSubscriptions.set(address.toBase58(), (accountInfo) => {
                this.accountInfoMap.set(address.toBase58(), accountInfo);
                if (this.isInitialized) {
                    logger.trace(`Geyser AMM accouny update: ${address.toBase58()}`);
                    this.amm.update(this.accountInfoMap);
                }
            });
        }

        return geyserSubscriptions;
    }

    async waitForInitialized() {
        await this.resolveOnInitialized;
    }

}

export {GeyserJupiterUpdateHandler}
