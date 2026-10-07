export const countHanCharacters = (value: string) => value.match(/\p{Script=Han}/gu)?.length ?? 0
