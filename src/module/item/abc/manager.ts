import { FeatPF2e, ClassPF2e, ItemPF2e, ABCItemPF2e } from "@item/index";
import { AncestrySource, BackgroundSource, ClassSource, ItemSourcePF2e } from "@item/data";
import { ABCFeatureEntryData } from "@item/abc/data";
import { CharacterPF2e } from "@actor/index";
import type { FeatSource } from "@item/feat/data";
import { ErrorPF2e, sluggify } from "@util";

export interface ABCManagerOptions {
    assurance?: string[];
}

export class AncestryBackgroundClassManager {
    static async addABCItem(
        source: AncestrySource | BackgroundSource | ClassSource,
        actor: CharacterPF2e,
        options?: ABCManagerOptions
    ): Promise<ItemPF2e[]> {
        switch (source.type) {
            case "ancestry": {
                await actor.ancestry?.delete();
                return this.addFeatures(source, actor, true, options);
            }
            case "background": {
                await actor.background?.delete();
                return this.addFeatures(source, actor, true, options);
            }
            case "class": {
                await actor.class?.delete();

                source._id = randomID(16);
                source.flags.pf2e ??= {};
                source.flags.pf2e.insertedClassFeaturesLevel = actor.level;

                const itemsToCreate = await this.getClassFeaturesForLevel(source, 0, actor.level);
                itemsToCreate.sort((featureA, featureB) => {
                    const levelA = featureA.data.level.value;
                    const levelB = featureB.data.level.value;
                    if (levelA > levelB) {
                        return 1;
                    } else if (levelA === levelB) {
                        return featureA.name > featureB.name ? 1 : -1;
                    } else {
                        return -1;
                    }
                });
                return actor.createEmbeddedDocuments("Item", [...itemsToCreate, source], { keepId: true });
            }
            default:
                throw ErrorPF2e("Invalid item type for ABC creation!");
        }
    }

    /** Add or remove class features as appropriate to the PC's level */
    static async ensureClassFeaturesForLevel(actor: CharacterPF2e, newLevel: number): Promise<void> {
        const actorClass = actor.class;
        if (!actorClass) return;

        const current = actor.itemTypes.feat.filter((feat) => feat.featType.value === "classfeature");
        if (newLevel > actor.level) {
            const classFeaturesToCreate = (
                await this.getClassFeaturesForLevel(actorClass, actor.level, newLevel)
            ).filter(
                (feature) => !current.some((currentFeature) => currentFeature.sourceId === feature.flags.core?.sourceId)
            );
            await actor.createEmbeddedDocuments("Item", classFeaturesToCreate, { keepId: true, render: false });
        } else if (newLevel < actor.level) {
            const classFeaturestoDelete = current.filter((feat) => feat.level > newLevel).map((feat) => feat.id);
            await actor.deleteEmbeddedDocuments("Item", classFeaturestoDelete, { render: false });
        }
    }

    static async getItemSource(packName: "pf2e.ancestries", name: string): Promise<AncestrySource>;
    static async getItemSource(packName: "pf2e.backgrounds", name: string): Promise<BackgroundSource>;
    static async getItemSource(packName: "pf2e.classes", name: string): Promise<ClassSource>;
    static async getItemSource(packName: "pf2e.feats-srd", name: string): Promise<FeatSource>;
    static async getItemSource(
        packName: "pf2e.ancestries" | "pf2e.backgrounds" | "pf2e.classes" | "pf2e.feats-srd",
        name: string
    ): Promise<AncestrySource | BackgroundSource | ClassSource | FeatSource> {
        const slug = sluggify(name);
        const pack = game.packs.get<CompendiumCollection<ABCItemPF2e>>(packName, { strict: true });
        const docs = await pack.getDocuments({ "data.slug": { $in: [slug] } });
        if (docs.length === 1) {
            return docs[0].toObject();
        } else {
            throw ErrorPF2e(`Cannot find '${name}' in pack '${packName}'`);
        }
    }

    protected static async getClassFeaturesForLevel(
        item: ClassPF2e | ClassSource,
        minLevel: number,
        actorLevel: number
    ): Promise<FeatSource[]> {
        if (minLevel >= actorLevel) {
            // no need to do anything, since we've seen it all
            return [];
        }

        const classSource = item instanceof ClassPF2e ? item.toObject() : item;
        const itemId = classSource._id;
        const featureEntries = classSource.data.items;
        const featuresToAdd = Object.values(featureEntries).filter(
            (entryData) => actorLevel >= entryData.level && entryData.level > minLevel
        );

        return this.getFeatures(featuresToAdd, itemId);
    }

    protected static async getFeatures(entries: ABCFeatureEntryData[], locationId: string): Promise<FeatSource[]> {
        const feats: FeatSource[] = [];
        if (entries.length > 0) {
            // Get feats from a compendium pack
            const packEntries = entries.filter((entry) => !!entry.pack);
            if (packEntries.length > 0) {
                const compendiumFeats = await this.getFromCompendium(packEntries);
                feats.push(
                    ...compendiumFeats.map((feat) => {
                        if (feat instanceof FeatPF2e) {
                            const featSource = feat.toObject();
                            featSource._id = randomID(16);
                            featSource.data.location = locationId;
                            return featSource;
                        } else {
                            throw ErrorPF2e("Invalid item type referenced in ABCFeatureEntryData");
                        }
                    })
                );
            }
            // Get feats from the game.items collection
            const gameEntries = entries.filter((entry) => !entry.pack);
            feats.push(
                ...gameEntries.map((entry) => {
                    const item = game.items.get(entry.id);
                    if (item instanceof FeatPF2e) {
                        const itemData = item.toObject();
                        itemData._id = randomID(16);
                        return itemData;
                    } else {
                        throw ErrorPF2e("Invalid item type referenced in ABCFeatureEntryData");
                    }
                })
            );
        }
        return feats;
    }

    protected static async getFromCompendium(entries: ABCFeatureEntryData[]): Promise<FeatPF2e[]> {
        const feats: FeatPF2e[] = [];
        // Entries can be from different packs
        const packs = new Set(entries.map((entry) => entry.pack!));
        for await (const pack of packs) {
            // Only fetch feats that are in this pack
            const entryIds = entries.filter((entry) => entry.pack === pack).map((entry) => entry.id);
            const features = await game.packs
                .get<CompendiumCollection<FeatPF2e>>(pack, { strict: true })
                // Use NeDB query to fetch all needed feats in one transaction
                .getDocuments({ _id: { $in: entryIds } });
            // For class features, set the level to the one prescribed in the class item
            for (const feature of features) {
                const entry = entries.find((e) => e.id === feature.id);
                if (entry && feature.featType.value === "classfeature") {
                    feature.data._source.data.level.value = entry.level;
                    feature.prepareData();
                }
            }

            feats.push(...features);
        }
        return feats;
    }

    protected static async addFeatures(
        itemSource: AncestrySource | BackgroundSource,
        actor: CharacterPF2e,
        createSource = false,
        options?: ABCManagerOptions
    ): Promise<ItemPF2e[]> {
        const itemsToCreate: ItemSourcePF2e[] = [];
        if (createSource) {
            itemSource._id = randomID(16);
            itemsToCreate.push(itemSource);
        }
        const entriesData = Object.values(itemSource.data.items);
        itemsToCreate.push(...(await this.getFeatures(entriesData, itemSource._id)));

        if (options?.assurance) {
            for (const skill of options.assurance) {
                const index = itemsToCreate.findIndex((item) => item.data.slug === "assurance");
                if (index > -1) {
                    const location = (itemsToCreate[index] as FeatSource).data.location;
                    itemsToCreate[index] = await this.getItemSource("pf2e.feats-srd", `Assurance (${skill})`);
                    itemsToCreate[index]._id = randomID(16);
                    (itemsToCreate[index] as FeatSource).data.location = location;
                }
            }
        }
        return actor.createEmbeddedDocuments("Item", itemsToCreate, { keepId: true });
    }
}
