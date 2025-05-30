import { combineLatest, Subscription } from 'rxjs';
import { UntypedFormControl, UntypedFormGroup } from '@angular/forms';
import { Component, Inject, OnDestroy, OnInit, ViewEncapsulation } from '@angular/core';

import { PagedResults } from '@auditmation/types-core-js';
import { ModuleSearch } from '@auditmation/module-auditmation-auditmation-store';
import { ProductExtended } from '@auditmation/module-auditmation-auditmation-portal';
import { Org, ServiceAccount, User } from '@auditmation/module-auditmation-auditmation-dana';
import { getZerobiasClientApiUrl, ZerobiasAppService, ZerobiasClientApiService } from '@auditmation/ngx-zb-client-lib';
import { GithubClient, newGithub, Organization, OrganizationApi, Repository } from '@auditlogic/module-github-github-client-ts';
import { ConnectionListView, ScopeListView, SearchConnectionBody, SearchScopeBody, SortObject } from '@auditmation/module-auditmation-auditmation-hub';

  /*
    // basic outline of this demo
    1. catalog example:  section, list of 5 products w/ logo
    2. module example:   section, <--- use auditlogic module for github
      select a Zerobias org 
      select a Connection (for github product) to get target <--- hubClient.getConnectionApi().search
        TODO: if creating a connection (future path) go to oauth page
      select scope <-- set to default scope if only 1 - hubClient.getScopeApi().search()
      call list github orgs on connection
      show list of repos by org
  */

@Component({
  selector: 'app-root',
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss',
  encapsulation: ViewEncapsulation.None
})
export class AppComponent implements OnInit, OnDestroy {

  private subscriptions = new Subscription();

  public loading = false;

  // Zerobias client library and modules give us many strongly typed interfaces!
  public orgs: Org[] = [];
  public githubOrgs: Organization[] = [];
  public currentOrg: Org = null;
  public currentUser: User | ServiceAccount = null;
  public products: ProductExtended[] = [];
  public githubProduct: ProductExtended;
  public connections: ConnectionListView[] = [];
  public selectedConnection: ConnectionListView;
  public scopes: ScopeListView[] = [];
  public selectedScope: ScopeListView;
  public selectedGithubOrg: Organization;
  public githubRepos: Repository[];

  // github client Module 
  public githubClient: GithubClient;

  // FormGroup for html selectors 
  public formGroup: UntypedFormGroup = new UntypedFormGroup({
    org: new UntypedFormControl(null),
    product: new UntypedFormControl(null),
    connection: new UntypedFormControl(null),
    scope: new UntypedFormControl(null),
    githubOrg: new UntypedFormControl(null),
  });

  constructor(
    protected clientApi: ZerobiasClientApiService,
    protected zerobiasAppService: ZerobiasAppService,
    @Inject('environment') private environment: any
  ) {}

  public ngOnInit(): void {
    this.loading = true;

    // for Product List demo block, calls to Zerobias Catalog
    this.getProducts();

    // for Zerobias Org selector
    this.subscriptions.add(this.zerobiasAppService.orgs.subscribe((orgs: Org[]) => {
      this.orgs = orgs;
    }));

    // subscribe to the Org and WhoAmI observables; 
    // combineLatest since we need both at the same time so 
    // this runs when either org or whoAmI changes i.e. changing Zerobias Org
    this.subscriptions.add(combineLatest(
      [this.zerobiasAppService.whoAmI, this.zerobiasAppService.org]).subscribe(([whoAmI, org]:any[]) => {
      this.currentUser = whoAmI;
      this.currentOrg = org;
      
      // set the org formcontrol value
      this.formGroup.get('org').setValue(org, {emitEvent: false});

      if (whoAmI && org) {
        if (this.githubProduct) {
          this.getConnections();
        } else {
          this.getGithubProduct().then((githubProduct) => {
            this.githubProduct = githubProduct;
            this.formGroup.get('product').setValue(githubProduct, {emitEvent: false});
            this.formGroup.get('product').disable(); // we're only using github for this demo - not changeable

            // update list of Connections
            this.getConnections();
          });
        }
      }
    }));

    // listen for Org select changes
    this.subscriptions.add(this.formGroup.get('org').valueChanges.subscribe((org:Org) => {
      // console.log('org change', org);

      // this will cascade and update our observables whoami and org
      if (org.id && (org.id.toString() !== this.currentOrg.id.toString())) {
        this.zerobiasAppService.selectOrg(org);
      }
    }));

    // listen for Connection select changes
    this.subscriptions.add(this.formGroup.get('connection').valueChanges.subscribe((connection: ConnectionListView) => {
      console.log('Connection change', connection);

      if (connection.id && (connection.id.toString() !== this.selectedConnection?.id.toString())) {
        this.selectedConnection = connection;

        // get Scopes for this Connection
        this.getConnectionScopes();
      }
    }));

    // listen for Connection SCOPE select changes
    this.subscriptions.add(this.formGroup.get('scope').valueChanges.subscribe((scope: ScopeListView) => {
      console.log('scope change', scope);

      if (scope.id && (scope.id.toString() !== this.selectedScope?.id.toString())) {
        this.selectedScope = scope;

        // get Github orgs using this scope
        this.getGithubOrgs();
      }
    }));

    // listen for Github Org select changes
    this.subscriptions.add(this.formGroup.get('githubOrg').valueChanges.subscribe((githubOrg: Organization) => {
      console.log('githubOrg change', githubOrg);

      if (githubOrg.id && (githubOrg.id.toString() !== this.selectedGithubOrg?.id.toString())) {
        this.selectedGithubOrg = githubOrg;
        // get repos for this Github org
        this.listRepositories();
      }
    }));

  }

  public ngOnDestroy(): void {
    this.subscriptions.unsubscribe();
  }

  public compareObjects(object1: any, object2: any) {
    return object1 && object2 && object1.id.toString() === object2.id.toString();
  }

  public getProducts() {
    this.clientApi.portalClient.getProductApi().search({}, 1, 5, null).then((pagedResults:PagedResults<ProductExtended>) => {
      this.products = pagedResults.items;
    })
  }

  public async getGithubProduct() {
    return this.clientApi.portalClient.getProductApi().search({packageCode: 'github.github'}, 1, 1).then((pagedResults:PagedResults<ProductExtended>) => {
      return pagedResults.items[0];
    });
  }

  public async getConnections() {
    // don't bother unless we have a githubProduct
    if (this.githubProduct) {
      this.loading = true;

      // find list of Module ids that use Github Product
      const moduleIds = await this.clientApi.storeClient.getModuleApi().search({products: [this.githubProduct.id]}, 1, 50, null).then((pagedResults:PagedResults<ModuleSearch>) => {
        return pagedResults.items.map(el => el.id);
      });

      // next use hubClient Connection API search to find Connections that use the Github Module
      /* 
      SearchConnectionBody {
          'name'?: string;
          'description'?: string;
          'statuses'?: Array<ConnectionOperationalStatusDef>;
          'orgs'?: Array<UUID>;
          'nodes'?: Array<UUID>;
          'boundaryIds'?: Array<UUID>;
          'boundaries'?: Array<UUID>;
          'products'?: Array<UUID>;
          'modules'?: Array<UUID>; <--- we'll use this one to find Connections that use the Github module 
      */
      const searchConnectionBody: SearchConnectionBody = {
        modules: moduleIds,
      };
      this.clientApi.hubClient.getConnectionApi().search(searchConnectionBody, 1, 50, null).then((pagedResults:PagedResults<ConnectionListView>) => {
        this.connections = pagedResults.items.length > 0 ? pagedResults.items : [];
      }).finally(() => {
        this.loading = false;
      });
    }
  }

  public getConnectionScopes() {
    /* 
    SearchScopeBody {
        'name'?: string;
        'description'?: string;
        'statuses'?: Array<ConnectionOperationalStatusDef>;
        'adminStatuses'?: Array<AdminStatusDef>;
        'connections'?: Array<UUID>;     // <--- this is our property for this search call
        'boundaries'?: Array<UUID>;
        'deployments'?: Array<UUID>;
        'nodes'?: Array<UUID>;
        'orgs'?: Array<UUID>;
        'modules'?: Array<UUID>;

    SortObject {
        'active'?: string; // column name
        'direction'?: string; // asc, desc
    */

    this.loading = true;
    const searchScopeBody: SearchScopeBody = {
      connections: [this.selectedConnection.id],
    };
    
    this.clientApi.hubClient.getScopeApi().search(searchScopeBody, 1, 50, new SortObject('name', 'asc')).then((pagedResults:PagedResults<ScopeListView>) => {
      this.scopes = pagedResults.items.length > 0 ? pagedResults.items : [];
      if (this.scopes.length === 1) {
        // if only one scope go ahead and select it by setting value of `scope` formControl
        this.formGroup.get('scope').setValue(this.scopes[0]);
      } else {
        this.loading = false;
      }
    })
  }

  public async getGithubOrgs() {
    this.loading = true;
    this.githubClient = newGithub(); // type GithubClient
    const hubConnectionProfile = {
      server: getZerobiasClientApiUrl('hub', this.environment.isLocalDev),
      targetId: this.clientApi.toUUID(this.selectedScope.id)  // <--- connection id if one scope/ scope id if multi-scope
    }
    // console.log('hubConnectionProfile: ',hubConnectionProfile);

    // get GITHUB orgs
    this.githubClient.connect(hubConnectionProfile).then(async () => {
      
      await this.githubClient.getOrganizationApi().listMyOrganizations(1,5).then((pagedResults: PagedResults<Organization>) => {
        this.githubOrgs = pagedResults.items.length > 0 ? pagedResults.items : [];
        // console.log('github orgs', pagedResults.items);
      }).finally(() => {
        this.loading = false;
      });
    });
  }

  private listRepositories() {
    /* 
      githubClient.getOrganizationApi().listRepositories(
        organizationName: string, 
        type?: OrganizationApi.TypeEnumDef, 
        sort?: OrganizationApi.SortEnumDef, 
        direction?: OrganizationApi.DirectionEnumDef, 
        pageNumber?: number, 
        pageSize?: number
      ) 
    */
    this.loading = true;
    this.githubClient.getOrganizationApi().listRepositories(
      this.selectedGithubOrg?.name,
      OrganizationApi.TypeEnum.All,
      OrganizationApi.SortEnum.FullName,
      OrganizationApi.DirectionEnum.Asc,
      1,
      25
    ).then((pagedResults: PagedResults<Repository>) => {
      this.githubRepos = pagedResults.items.length > 0 ? pagedResults.items : [];
      // console.log('repos', pagedResults.items);
    }).finally(() => {
      this.loading = false;
    });
  }

}
