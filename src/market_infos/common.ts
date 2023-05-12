import { Amm } from "@jup-ag/core";
import { AccountInfoMap } from "@jup-ag/core/dist/lib/amm.js";
import { PublicKey } from "@solana/web3.js";
import { connection } from "../clients/rpc.js";
import { AccountSubscriptionHandlersMap } from "../clients/geyser.js";
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
            const handler = (accountInfo) => {
                this.accountInfoMap.set(address.toBase58(), accountInfo);
                if (this.isInitialized) {
                    logger.trace(`Geyser AMM accouny update: ${address.toBase58()}`);
                    try {
                        this.amm.update(this.accountInfoMap);
                    } catch (e) {
                        logger.error(`Geyser AMM update failed: ${this.amm.label} ${this.amm.id} ${e}`);
                    }
                }
            }
            if (geyserSubscriptions.has(address.toBase58())) {
                geyserSubscriptions.get(address.toBase58()).push(handler);
            } else {
                geyserSubscriptions.set(address.toBase58(), [handler]);
            }
        }

        return geyserSubscriptions;
    }

    async waitForInitialized() {
        await this.resolveOnInitialized;
    }

}

function toPairString(mintA: PublicKey, mintB: PublicKey): string {
    if (mintA.toBase58() < mintB.toBase58()) {
        return `${mintA.toBase58()}-${mintB.toBase58()}`;
    } else {
        return `${mintB.toBase58()}-${mintA.toBase58()}`;
    }
}

export {GeyserJupiterUpdateHandler, toPairString}