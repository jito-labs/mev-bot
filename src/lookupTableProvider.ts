import {
  AccountInfo,
  AddressLookupTableAccount,
  AddressLookupTableProgram,
  PublicKey,
} from '@solana/web3.js';
import { GeyserProgramUpdateClient } from './geyser.js';
import { connection } from './connection.js';

class LookupTableProvider {
  lookupTables: Map<string, AddressLookupTableAccount>;
  lookupTablesforAddress: Map<string, Set<string>>;
  geyserClient: GeyserProgramUpdateClient;

  constructor() {
    this.lookupTables = new Map();
    this.lookupTablesforAddress = new Map();
    this.geyserClient = new GeyserProgramUpdateClient(
      AddressLookupTableProgram.programId,
      this.processLookupTableUpdate.bind(this),
    );
  }

  private processLookupTableUpdate(
    lutAddress: PublicKey,
    data: AccountInfo<Buffer>,
  ) {
    const lutAccount = new AddressLookupTableAccount({
      key: lutAddress,
      state: AddressLookupTableAccount.deserialize(data.data),
    });

    this.lookupTables.set(lutAddress.toBase58(), lutAccount);

    for (const address of lutAccount.state.addresses) {
      const addressStr = address.toBase58();
      if (!this.lookupTablesforAddress.has(addressStr)) {
        this.lookupTablesforAddress.set(addressStr, new Set());
      }
      this.lookupTablesforAddress.get(addressStr).add(lutAddress.toBase58());
    }
    return;
  }

  async getLookupTable(
    lutAddress: PublicKey,
  ): Promise<AddressLookupTableAccount | null> {
    const lutAddressStr = lutAddress.toBase58();
    if (this.lookupTables.has(lutAddressStr)) {
      return this.lookupTables.get(lutAddressStr);
    }

    const lut = await connection.getAddressLookupTable(lutAddress);
    if (lut.value === null) {
      return null;
    }

    this.lookupTables.set(lutAddressStr, lut.value);

    for (const address of lut.value.state.addresses) {
      const addressStr = address.toBase58();
      if (!this.lookupTablesforAddress.has(addressStr)) {
        this.lookupTablesforAddress.set(addressStr, new Set());
      }
      this.lookupTablesforAddress.get(addressStr).add(lutAddressStr);
    }

    return lut.value;
  }
}

const lookupTableProvider = new LookupTableProvider();

export {lookupTableProvider}
