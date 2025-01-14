import { OperationDefinitionNode } from 'graphql'
import { Config, fs, GenerateHookInput, path } from 'houdini'

import {
	type_route_dir,
	stores_directory_name,
	store_suffix,
	Framework,
	walk_routes,
} from '../../kit'

export default async function svelteKitGenerator(
	framework: Framework,
	{ config }: GenerateHookInput
) {
	// this generator creates the locally imported type definitions.
	// the component type generator will handle
	if (framework !== 'kit') {
		return
	}

	await walk_routes(config, framework, {
		async route({
			dirpath,
			svelteTypeFilePath,
			layoutQueries,
			pageQueries,
			layoutExports,
			pageExports,
		}) {
			//remove testing later
			const relativePath = path.relative(config.routesDir, dirpath)
			const target = path.join(type_route_dir(config), relativePath, config.typeRootFile)

			const houdiniRelative = path.relative(target, config.typeRootDir)

			const queryNames: string[] = []
			const uniquePageQueries: OperationDefinitionNode[] = []
			for (const query of pageQueries) {
				if (!queryNames.includes(query.name!.value)) {
					queryNames.push(query.name!.value)
					uniquePageQueries.push(query)
				}
			}

			const layoutNames: string[] = []
			const uniqueLayoutQueries: OperationDefinitionNode[] = []
			for (const layout of layoutQueries) {
				if (!layoutNames.includes(layout.name!.value)) {
					layoutNames.push(layout.name!.value)
					uniqueLayoutQueries.push(layout)
				}
			}

			// read the svelte-kit $types.d.ts file into a string
			let skTypeString = await fs.readFile(svelteTypeFilePath)

			//if the file is truthy (not empty)
			if (skTypeString) {
				//get the type imports for file

				const pageTypeImports = getTypeImports(houdiniRelative, config, uniquePageQueries)
				const layoutTypeImports = getTypeImports(
					houdiniRelative,
					config,
					uniqueLayoutQueries
				)

				// Util bools for ensuring no unnecessary types
				const afterPageLoad = pageExports.includes('afterLoad')
				const beforePageLoad = pageExports.includes('beforeLoad')
				const onPageError = pageExports.includes('onError')

				const afterLayoutLoad = layoutExports.includes('afterLoad')
				const beforeLayoutLoad = layoutExports.includes('beforeLoad')
				const onLayoutError = layoutExports.includes('onError')

				//check if either page or layout has variables exported.
				const pageVariableLoad = pageExports.some((x) => x.endsWith('Variables'))
				const layoutVariableLoad = layoutExports.some((x) => x.endsWith('Variables'))

				//default sktype string is defined as imports \n\n utility \n\n exports
				const splitString = skTypeString.split('\n\n')

				//name our sections
				let typeImports = splitString[0]
				let utilityTypes = splitString[1]
				let typeExports = splitString[2]

				// lots of comparisons but helpful to prevent unnecessary imports
				// define function imports e.g. import {VariableFunction, AferLoadFunction, BeforeLoadFunction} from 'relativePath'
				// will not include unnecessary imports.
				const functionImports = `${
					afterPageLoad ||
					beforePageLoad ||
					afterLayoutLoad ||
					beforeLayoutLoad ||
					pageVariableLoad ||
					layoutVariableLoad
						? `\nimport type { ${
								layoutVariableLoad || pageVariableLoad ? 'VariableFunction, ' : ''
						  }${afterLayoutLoad || afterPageLoad ? 'AfterLoadFunction, ' : ''}${
								beforeLayoutLoad || beforePageLoad ? 'BeforeLoadFunction ' : ''
						  }} from '${houdiniRelative}/plugins/houdini-svelte/runtime/types';`
						: ''
				}`

				// mutate typeImports with our functionImports, layout/pageStores, $result, $input,
				typeImports = typeImports
					.concat(functionImports)
					.concat(layoutTypeImports)
					.concat(pageTypeImports)

				// if we need Page/LayoutParams, generate this type.
				// verify if necessary. might not be.
				const layoutParams = `${
					layoutQueries.length > 0 && !utilityTypes.includes('LayoutParams')
						? "\ntype LayoutParams = LayoutLoadEvent['params'];"
						: ''
				}`

				//page params are necessary though.
				const pageParams = `${
					pageQueries.length > 0 && !utilityTypes.includes('PageParams')
						? "\ntype PageParams = PageLoadEvent['params'];"
						: ''
				}`

				// mutate utilityTypes with our layoutParams, pageParams.
				utilityTypes = utilityTypes
					.concat(layoutParams)
					.concat(pageParams)
					//replace all instances of $types.js with $houdini to ensure type inheritence.
					//any type imports will always be in the utilityTypes block
					.replaceAll(/\$types\.js/gm, '$houdini')

				// main bulk of the work done here.
				typeExports = typeExports
					//we define the loadInput, checks if any queries have imports
					.concat(append_loadInput(layoutQueries))
					.concat(append_loadInput(pageQueries))
					//define beforeLoad and afterLoad types layout always first
					.concat(append_beforeLoad(beforeLayoutLoad))
					.concat(append_beforeLoad(beforePageLoad))
					.concat(append_afterLoad('Layout', afterLayoutLoad, layoutQueries))
					.concat(append_afterLoad('Page', afterPageLoad, pageQueries))
					.concat(
						append_onError(
							onPageError,
							//if there are not inputs to any query, we won't define a LoadInput in our error type
							pageQueries.filter((x) => x.variableDefinitions?.length).length > 0
						)
					)
					.concat(
						append_onError(
							onLayoutError,
							//if there are not inputs to any query, we won't define a LoadInput in our error type
							pageQueries.filter((x) => x.variableDefinitions?.length).length > 0
						)
					)
					.concat(append_VariablesFunction('Layout', config, uniqueLayoutQueries))
					.concat(append_VariablesFunction('Page', config, uniquePageQueries))
					//match all between 'LayoutData =' and ';' and combine additional types
					.replace(
						//regex to append our generated stores to the existing
						//match all between 'LayoutData =' and ';' and combine additional types
						/(?<=LayoutData = )([\s\S]*?)(?=;)/,
						`Expand<$1 & { ${layoutQueries
							.map((query) => {
								const name = query.name!.value

								return [name, name + store_suffix(config)].join(': ')
							})
							.join('; ')} }${internal_append_TypeDataExtra(
							beforeLayoutLoad,
							afterLayoutLoad,
							onLayoutError
						)}>`
					)
					.replace(
						//regex to append our generated stores to the existing
						//match all between 'PageData =' and ';' and combine additional types
						/(?<=PageData = )([\s\S]*?)(?=;)/,
						`Expand<$1 & { ${pageQueries
							.map((query) => {
								const name = query.name!.value

								return [name, name + store_suffix(config)].join(': ')
							})
							.join('; ')} }${internal_append_TypeDataExtra(
							beforePageLoad,
							afterPageLoad,
							onPageError
						)}>`
					)

				//make dir of target if not exist
				await fs.mkdirp(path.dirname(target))
				// write the file
				await fs.writeFile(target, [typeImports, utilityTypes, typeExports].join('\n\n'))

				if (typeExports.includes('proxy')) {
					const proxyDir = path.dirname(svelteTypeFilePath)
					const proxyDirContent = await fs.readdir(proxyDir)
					const proxyFiles = proxyDirContent.filter((name) => name.includes('proxy'))
					for (const element of proxyFiles) {
						const src = path.join(proxyDir, element)
						const dest = path.join(path.dirname(target), element)
						await fs.copyFile(src, dest)
					}
				}
			}
		},
	})
}

function getTypeImports(
	houdiniRelative: string,
	config: Config,
	queries: OperationDefinitionNode[]
) {
	return queries
		.map((query) => {
			const name = query.name!.value
			return `\nimport { ${name}$result, ${name}$input } from '${houdiniRelative}/${
				config.artifactDirectoryName
			}/${name}';\nimport { ${name}Store } from '${houdiniRelative}/plugins/houdini-svelte/${stores_directory_name()}/${name}';`
		})
		.join('\n')
}

function append_VariablesFunction(
	type: `Page` | `Layout`,
	config: Config,
	queries: OperationDefinitionNode[]
) {
	return queries
		.map((query) => {
			const name = query.name!.value
			// if the query does not have any variables, don't include anything
			if (!query.variableDefinitions?.length) {
				return ''
			}

			return `\nexport type ${config.variableFunctionName(
				name
			)} = VariableFunction<${type}Params, ${name}$input>;`
		})
		.join('\n')
}

function append_loadInput(queries: OperationDefinitionNode[]) {
	return `${
		queries.filter((q) => q.variableDefinitions?.length).length
			? `\ntype LoadInput = { ${queries
					.filter((query) => query.variableDefinitions?.length)
					.map((query) => {
						// if the query does not have any variables, don't include anything
						const name = query.name!.value

						return [name, name + '$input'].join(': ')
					})
					.join('; ')} };`
			: ''
	}`
}

function append_afterLoad(
	type: `Page` | `Layout`,
	afterLoad: boolean,
	queries: OperationDefinitionNode[]
) {
	return afterLoad
		? `
type AfterLoadReturn = ReturnType<typeof import('./+${type.toLowerCase()}').afterLoad>;
type AfterLoadData = {
	${internal_append_afterLoad(queries)}
};

export type AfterLoadEvent = {
	event: PageLoadEvent
	data: AfterLoadData
	input: ${queries.filter((q) => q.variableDefinitions?.length).length ? 'LoadInput' : '{}'}
};
`
		: ''
}

function internal_append_afterLoad(queries: OperationDefinitionNode[]) {
	return `${queries
		.map((query) => {
			// if the query does not have any variables, don't include anything
			const name = query.name!.value

			return [name, name + '$result'].join(': ')
		})
		.join(';\n\t')}`
}

function append_beforeLoad(beforeLoad: boolean) {
	return beforeLoad
		? `
export type BeforeLoadEvent = PageLoadEvent;
type BeforeLoadReturn = ReturnType<typeof import('./+page').beforeLoad>;
`
		: ''
}

function append_onError(onError: boolean, hasLoadInput: boolean) {
	return onError
		? `
type OnErrorReturn = ReturnType<typeof import('./+page').onError>;
export type OnErrorEvent =  { event: Kit.LoadEvent, input: ${
				hasLoadInput ? 'LoadInput' : '{}'
		  }, error: Error | Error[] };
`
		: ''
}

function internal_append_TypeDataExtra(beforeLoad: boolean, afterLoad: boolean, onError: boolean) {
	return `${beforeLoad ? ' & BeforeLoadReturn' : ''}${afterLoad ? ' & AfterLoadReturn' : ''}${
		onError ? ' & OnErrorReturn' : ''
	}`
}
