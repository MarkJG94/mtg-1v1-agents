/** Magic's five colours, in WUBRG order (CR 105.1). */
export const colours = ['W', 'U', 'B', 'R', 'G'] as const;
export type Colour = (typeof colours)[number];

const colourSet: ReadonlySet<string> = new Set(colours);

export const isColour = (value: string): value is Colour => colourSet.has(value);
