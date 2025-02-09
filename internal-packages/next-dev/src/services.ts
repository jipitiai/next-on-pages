import { Request as NodeFetchRequest } from 'node-fetch';
import { Response } from 'miniflare';
import type { Request } from 'miniflare';
import type { WorkerDefinition } from './wrangler';
import { getRegisteredWorkers, type WorkerRegistry } from './wrangler';
import fetch from 'node-fetch';
import { warnAboutExternalBindingsNotFound } from './utils';

/**
 * Gets service bindings that proxy requests to external workers running locally, so that they
 * can be passed to miniflare and used to fetch from such workers by the next app.
 *
 * @param services the services requested by the user
 * @returns the service bindings ready to be passed to miniflare
 */
export async function getServiceBindings(
	services: Record<string, string> | undefined,
): Promise<ServiceBindings | undefined> {
	if (Object.keys(services ?? {}).length === 0) {
		return;
	}

	let registeredWorkers: WorkerRegistry | undefined;

	try {
		registeredWorkers = await getRegisteredWorkers();
	} catch {
		/* */
	}

	if (!registeredWorkers) {
		warnAboutServicesNotFound(new Set(Object.keys(services ?? {})));
		return;
	}

	const [foundServices, missingServices] = Object.entries(
		services ?? {},
	).reduce(
		([found, missing], [bindingName, serviceName]) => {
			// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
			const service = registeredWorkers![serviceName];
			return service
				? [
						[...found, { bindingName, serviceName, workerDefinition: service }],
						missing,
				  ]
				: [found, [...missing, { bindingName }]];
		},
		[[], []] as [
			AvailableBindingInfo[],
			Pick<AvailableBindingInfo, 'bindingName'>[],
		],
	);

	if (missingServices.length) {
		warnAboutServicesNotFound(
			new Set(missingServices.map(({ bindingName }) => bindingName)),
		);
	}

	const serviceBindings = foundServices.reduce((acc, bindingInfo) => {
		return {
			...acc,
			[bindingInfo.bindingName]: getServiceBindingProxyFetch(bindingInfo),
		};
	}, {} as ServiceBindings);

	return serviceBindings;
}

type ServiceBindings = Record<string, (req: Request) => Promise<Response>>;

type AvailableBindingInfo = {
	bindingName: string;
	serviceName: string;
	workerDefinition: WorkerDefinition;
};

/**
 * Given all the relevant information about a service binding and its relative worker definition this
 * function generates a proxy fetch that takes requests targeted to the service and proxies them to it
 *
 * @param availableBindingInfo the binding information to be used to create a proxy to an external service
 * @returns the binding proxy (in the form of a nodejs fetch method)
 */
function getServiceBindingProxyFetch({
	workerDefinition,
	bindingName,
	serviceName,
}: AvailableBindingInfo) {
	const { protocol, host, port } = workerDefinition;

	const getExternalUrl = (request: Request) => {
		const newUrl = new URL(request.url);
		if (protocol) newUrl.protocol = protocol;
		if (host) newUrl.host = host;
		if (port) newUrl.port = `${port}`;
		return newUrl;
	};

	return async (request: Request) => {
		const newUrl = getExternalUrl(request);
		const newRequest = new NodeFetchRequest(
			newUrl,
			request as unknown as NodeFetchRequest,
		);
		try {
			const resp = await fetch(newRequest);
			const respBody = await resp.arrayBuffer();
			return new Response(respBody, resp as unknown as Response);
		} catch {
			return new Response(
				`Error: Unable to fetch from external service (${serviceName} bound with ${bindingName} binding), please make sure that the service is still running with \`wrangler dev\``,
				{ status: 500 },
			);
		}
	};
}

function warnAboutServicesNotFound(servicesNotFound: Set<string>): void {
	warnAboutExternalBindingsNotFound(servicesNotFound, 'Service Bindings');
}
